import { eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { EVENTS } from '@shared/ipc';
import { broadcast } from '../../ipc/broadcast';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { sessionsRepo } from '../../db/repositories/sessions.repo';
import { providerFor } from '../../providers/registry';
import { getOverlayWindow, showOverlay } from '../../windows/overlayWindow';
import { getMainWindow } from '../../windows/mainWindow';
import { log } from '../security/logger';
import { EngineSession } from './engineSession';
import { interviewMode } from './modes/interview.mode';
import { meetingMode } from './modes/meeting.mode';
import { getOrGenerateMeetingReport } from './meetingReport';
import { enginePersistence } from './persistence/enginePersistence';
import { createRealtimeSource, pcmLevel } from './sourceAdapter';
import type { AnswerFormat, InterviewType, Presence, Session, SessionMode } from '@shared/types';
import type { ModeDefinition } from './modeDefinition';

/** Mode registry: SessionMode → definition. Practice/mock rehearse through
 *  the interview pipeline; the flagged-off modes land with their prompts. */
function modeFor(mode: SessionMode | undefined): ModeDefinition {
  return mode === 'meeting' ? meetingMode : interviewMode;
}

function toSession(r: typeof schema.sessions.$inferSelect): Session {
  return {
    id: r.id,
    profileId: r.profileId,
    jobId: r.packId, // shared field name kept for IPC compatibility
    mode: r.mode as Session['mode'],
    kind: r.kind as Session['kind'],
    interviewType: r.interviewType as Session['interviewType'],
    status: r.status as Session['status'],
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    createdAt: r.createdAt,
  };
}

/**
 * The conversation engine: owns the ONE active EngineSession (v1 invariant),
 * its transcriber source, and the session lifecycle. Modes configure it —
 * today only interviewMode; sessionManager remains the backward-compatible
 * facade every IPC handler and the mock/sparring managers call.
 */
class Engine {
  private current: EngineSession | null = null;

  /** Set up the live session + Realtime transcriber (shared by start and
   *  resume; mock/sparring rehearsals come through here too via the facade's
   *  goLive). Tears down any previous live session first. */
  begin(opts: {
    sessionId: string;
    profileId: string;
    packId: string | null;
    interviewType: InterviewType;
    answerFormat: AnswerFormat;
    language: string;
    ephemeral?: boolean;
    mode?: SessionMode;
    presence?: Presence;
  }): void {
    this.current?.teardown(); // cancel any prior in-flight answer; never leak a socket
    const modeDef = modeFor(opts.mode);
    const session = new EngineSession({
      sessionId: opts.sessionId,
      profileId: opts.profileId,
      packId: opts.packId,
      mode: modeDef,
      settings: {
        interviewType: opts.interviewType,
        answerFormat: opts.answerFormat,
        pronunciation: true, // ON by default (v1.2); toggled live from the Cue Card
        presence: opts.presence ?? modeDef.defaultPresence,
      },
      ephemeral: !!opts.ephemeral,
    });
    this.current = session;
    showOverlay();
    // The live session captures loopback audio, which clears our windows'
    // capture-exclusion at capture start; the always-on protection observer
    // (startProtectionObserver) detects and heals that within one tick.

    // Real sessions stream STT via the Realtime API. A mock rehearsal has no
    // mic — its questions come from the AI interviewer — so skip the transcriber.
    if (!opts.ephemeral) {
      const transcriber = createRealtimeSource(
        {
          onDelta: (text) =>
            broadcast(EVENTS.transcriptDelta, {
              text,
              isFinal: false,
              speaker: session.mode.remoteSpeaker,
            }),
          onFinal: (text) => void this.processFinalTranscript(opts.sessionId, text),
          onError: (message) => broadcast(EVENTS.sessionError, { message }),
          // Socket lifecycle → a subtle "reconnecting audio…" pill in the Cue Card
          // (an unexpected drop mid-session now recovers itself; see realtime.ts).
          onStatus: (status) => broadcast(EVENTS.transcriberStatus, { status }, ['overlay']),
        },
        opts.language || 'en',
      );
      session.transcriber = transcriber; // opened already-started by the provider
    }

    broadcast(EVENTS.sessionState, { status: 'live', paused: false });
    // Seed the Cue Card's answer-control toggles with this round's prefs.
    broadcast(
      EVENTS.answerPrefs,
      {
        interviewType: opts.interviewType,
        format: opts.answerFormat,
        pronunciation: true,
      },
      ['overlay'],
    );
    // Push the pack (client) + profile context to the Cue Card: it shows which
    // interview is running and lets the user pull up their notes mid-session.
    const pack = opts.packId ? contextPacksRepo.get(opts.packId) : null;
    const profile = profilesRepo.get(opts.profileId);
    broadcast(
      EVENTS.clientInfo,
      {
        company: pack?.company ?? null,
        title: pack?.title ?? (modeDef.id === 'meeting' ? 'Meeting' : 'Interview'),
        notes: pack?.notes ?? null,
        profileName: profile?.name ?? null,
        hasResume: !!profile?.parsedResume,
        hasJd: !!pack?.parsedJd,
        hasCompany: !!pack?.parsedCompany,
      },
      ['overlay'],
    );
  }

  start(
    profileId: string,
    interviewType: InterviewType,
    packId: string | null = null,
    answerFormat: AnswerFormat = 'key_points',
    opts: { mode?: SessionMode; presence?: Presence } = {},
  ): Session {
    const profile = profilesRepo.get(profileId);
    if (!profile) throw new Error('Profile not found');
    const id = crypto.randomUUID();
    db()
      .insert(schema.sessions)
      .values({
        id,
        profileId,
        packId,
        mode: opts.mode ?? 'interview',
        kind: 'live',
        interviewType,
        status: 'live',
        startedAt: Date.now(),
      })
      .run();
    this.begin({
      sessionId: id,
      profileId,
      packId,
      interviewType,
      answerFormat,
      language: profile.language,
      mode: opts.mode,
      presence: opts.presence,
    });
    return toSession(db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()!);
  }

  /** Re-activate an existing (stopped) session and continue it, so one interview
   *  reuses a single session row instead of piling up new ones. The interview
   *  TYPE is restored from the session (it's switched live in the Cue Card, not
   *  chosen on resume); the answer format defaults and is adjusted live too. */
  resume(sessionId: string, answerFormat: AnswerFormat = 'key_points'): Session {
    const row = db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    if (!row) throw new Error('Session not found');
    const profile = profilesRepo.get(row.profileId);
    if (!profile) throw new Error('Profile not found');
    db()
      .update(schema.sessions)
      .set({ status: 'live', endedAt: null })
      .where(eq(schema.sessions.id, sessionId))
      .run();
    this.begin({
      sessionId,
      profileId: row.profileId,
      packId: row.packId,
      interviewType: row.interviewType as InterviewType,
      answerFormat,
      language: profile.language,
      mode: row.mode as SessionMode, // a meeting resumes as a meeting
    });
    return toSession(
      db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()!,
    );
  }

  /** Feed streaming PCM16 (24kHz mono) audio from the renderer to the transcriber. */
  feedRealtimeAudio(sessionId: string, pcm: ArrayBuffer): void {
    const s = this.current;
    if (!s || s.sessionId !== sessionId || s.paused) return;
    s.transcriber?.appendAudio(Buffer.from(pcm).toString('base64'));
    // Drive the Cue Card audio meter — the mic stream lives in the dashboard
    // renderer, so we compute the level here (from the PCM we already receive)
    // and broadcast it, throttled to ~12/sec.
    const now = Date.now();
    if (now - s.lastLevelAt >= 80) {
      s.lastLevelAt = now;
      broadcast(EVENTS.audioLevel, { level: pcmLevel(pcm) }, ['overlay']);
    }
  }

  /** Persist a finalized transcript turn and run it through the mode's trigger. */
  async processFinalTranscript(sessionId: string, text: string): Promise<void> {
    const s = this.current;
    if (!text || !s || s.sessionId !== sessionId || s.paused) return;
    await s.handleEvent({ kind: 'transcript_final', sessionId, text });
  }

  /** Chunked STT fallback (used only if Realtime is unavailable). */
  async ingestAudio(sessionId: string, audio: ArrayBuffer, mime: string): Promise<void> {
    const s = this.current;
    if (!s || s.sessionId !== sessionId || s.paused || s.busy) return;
    s.busy = true;
    try {
      const text = (await providerFor('batchStt').transcribe(audio, mime)).trim();
      if (text) await this.processFinalTranscript(sessionId, text);
    } catch (e) {
      log.error('ingestAudio failed', e);
      broadcast(EVENTS.sessionError, { message: 'Transcription failed.' });
    } finally {
      if (this.current === s) s.busy = false;
    }
  }

  stop(sessionId: string): Session {
    db()
      .update(schema.sessions)
      .set({ status: 'stopped', endedAt: Date.now() })
      .where(eq(schema.sessions.id, sessionId))
      .run();
    // Snapshot the row now so we can still return it even if a mock session is
    // deleted below. The row can already be gone (e.g. the user pressed Stop on a
    // mock while its first question was in flight) — fail cleanly, not TypeError.
    const row = db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
    if (!row) throw new Error('Session not found');
    const result = toSession(row);
    // Only tear down the live UI when we actually stopped the LIVE session —
    // stopping some other (already-stopped) session row must not kill a running
    // one or hide the overlay out from under it.
    const s = this.current;
    if (s && s.sessionId === sessionId) {
      const interviewType = s.settings.interviewType;
      const wasEphemeral = s.ephemeral;
      const wasMeeting = s.mode.id === 'meeting';
      const packTitle = s.packId ? (contextPacksRepo.get(s.packId)?.title ?? null) : null;
      s.teardown(); // stop any in-flight answer stream + the transcriber
      this.current = null;
      broadcast(EVENTS.sessionState, { status: 'stopped', paused: false });
      broadcast(EVENTS.clientInfo, null, ['overlay']); // clear the Cue Card's client notes
      getOverlayWindow()?.hide(); // close the floating overlay when the session ends
      if (wasEphemeral) {
        // Mock rehearsals are never persisted — drop the session + its Q/A.
        sessionsRepo.delete(sessionId);
      } else {
        // Ask the dashboard to save (pick the type) or discard the just-ended session.
        broadcast(
          EVENTS.savePrompt,
          {
            sessionId,
            interviewType,
            jobTitle: packTitle,
            questionCount: sessionsRepo.questionCount(sessionId),
          },
          ['main'],
        );
        const mainWin = getMainWindow();
        if (mainWin) {
          mainWin.show();
          mainWin.focus();
        }
        // Meetings get their end-of-session report generated eagerly (fire-and-
        // forget; the transcript + cards are already persisted). The Sessions
        // page falls back to get-or-generate if this fails or is still running.
        if (wasMeeting) {
          void getOrGenerateMeetingReport(sessionId).catch((e) =>
            log.warn('meeting report generation failed', e),
          );
        }
      }
    }
    return result;
  }

  /** Release the live transcription websocket on app exit so its socket/helper
   *  process doesn't linger. Does not touch the DB (the session row keeps its
   *  last status). Safe to call when nothing is live. */
  shutdown(): void {
    if (this.current) {
      this.current.teardown();
      this.current = null;
    }
  }

  togglePause(sessionId: string): { paused: boolean } {
    const s = this.current;
    if (!s || s.sessionId !== sessionId) return { paused: true };
    s.paused = !s.paused;
    broadcast(EVENTS.sessionState, { status: 'live', paused: s.paused });
    return { paused: s.paused };
  }

  /** Pause/resume whichever session is currently live (for overlay + hotkey,
   *  which don't carry a session id). No-op when nothing is live. */
  togglePauseActive(): { paused: boolean; active: boolean } {
    if (!this.current) return { paused: false, active: false };
    return { ...this.togglePause(this.current.sessionId), active: true };
  }

  /** Stop whichever session is currently live (for the Cue Card, which doesn't
   *  carry a session id). No-op when nothing is live. The 'stopped' sessionState
   *  broadcast tears down the dashboard store + mic too. */
  stopActive(): { stopped: boolean } {
    if (!this.current) return { stopped: false };
    this.stop(this.current.sessionId);
    return { stopped: true };
  }

  /** Manual or caller-classified question (mock rehearsals pass their own
   *  type): register + stream on the LIVE session. */
  async answerQuestion(
    sessionId: string,
    questionText: string,
    type = 'behavioral',
    confidence = 1,
    strategy = '',
    transcriptChunkId: string | null = null,
  ): Promise<{ questionId: string }> {
    const s = this.current;
    if (!s || s.sessionId !== sessionId) {
      // Preserve the v1 error for a missing row; a stopped-but-existing session
      // can no longer stream (it has no engine session to own the answer slot).
      const row = db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
      if (!row) throw new Error('Session not found');
      throw new Error('Session is not live');
    }
    return s.answerQuestion(questionText, { type, confidence, strategy }, transcriptChunkId);
  }

  /** The live session's current Answer Format (null when idle) — read by the coding
   *  solver so its four-beat delivery follows the Cue Card's format toggle. */
  activeAnswerFormat(): AnswerFormat | null {
    return this.current?.settings.answerFormat ?? null;
  }

  /** Update the live answer preferences (type / format / pronunciation). Type is
   *  dynamic — switching it mid-session just changes how subsequent answers are
   *  framed (each question is still classified + tagged independently). Takes
   *  effect on the next (or regenerated) answer. */
  setAnswerPrefs(prefs: {
    interviewType?: InterviewType;
    format?: AnswerFormat;
    pronunciation?: boolean;
  }): { interviewType: InterviewType; format: AnswerFormat; pronunciation: boolean } {
    const s = this.current;
    // No active session (idle Cue Card): no-op with sensible defaults.
    if (!s) {
      return {
        interviewType: prefs.interviewType ?? 'general',
        format: prefs.format ?? 'key_points',
        pronunciation: prefs.pronunciation ?? false,
      };
    }
    if (prefs.interviewType !== undefined) {
      s.settings.interviewType = prefs.interviewType;
      // Persist the latest type on the session row so the list/Reports reflect it.
      enginePersistence.updateInterviewType(s.sessionId, prefs.interviewType);
    }
    if (prefs.format !== undefined) s.settings.answerFormat = prefs.format;
    if (prefs.pronunciation !== undefined) s.settings.pronunciation = prefs.pronunciation;
    return {
      interviewType: s.settings.interviewType,
      format: s.settings.answerFormat,
      pronunciation: s.settings.pronunciation,
    };
  }

  async regenerate(questionId?: string): Promise<{ regenerated: boolean }> {
    if (!this.current) return { regenerated: false };
    return this.current.regenerate(questionId);
  }

  /** Clear the current answer: abort any in-flight stream for the active session.
   *  The Cue Card clears its own view; this stops tokens from continuing to arrive. */
  clearAnswerActive(): { cleared: boolean } {
    this.current?.answerAbort?.abort();
    return { cleared: true };
  }

  /** Manually ask a question for the active session (Cue Card "Ask" box). */
  async askActive(questionText: string): Promise<{ ok: boolean }> {
    const s = this.current;
    const text = questionText.trim();
    if (!s || !text) return { ok: false };
    await s.handleEvent({ kind: 'direct_ask', sessionId: s.sessionId, text });
    return { ok: true };
  }

  /** Enable/disable auto-answering for the active session. Coding sessions
   *  default to disabled (listen-only). Enabling it also answers the question
   *  just asked (remembered while suppressed), so toggling on catches up. */
  setAnsweringActive(enabled: boolean): { enabled: boolean; answered: boolean } {
    const s = this.current;
    if (!s) return { enabled: true, answered: false };
    s.suppressAnswers = !enabled;
    if (enabled && s.pendingQuestionText) {
      const text = s.pendingQuestionText;
      s.pendingQuestionText = null;
      void this.answerQuestion(s.sessionId, text).catch(() => {});
      return { enabled, answered: true };
    }
    return { enabled, answered: false };
  }
}

export const engine = new Engine();

import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { localSttModel, type LocalSttModel } from '@shared/stt';
import type {
  RealtimeSttCallbacks,
  RealtimeSttProvider,
  RealtimeSttSession,
} from '../../providers/types';
import { log } from '../security/logger';
import { installed, modelDir } from './modelStore';
import { toStandaloneArrayBuffer } from './pcm';
import { readSttPrefs } from './prefs';
import type { LoadMessage, WorkerIn, WorkerOut } from './protocol';

/**
 * The `local` realtimeStt provider (docs/22-LOCAL-STT.md). Same contract as
 * the OpenAI Realtime transcriber — base64 PCM16 24 kHz in, deltas and finals
 * out — but the recognizer is the sherpa-onnx worker (worker.ts) in a utility
 * process. Any number of sessions may be open at once, keyed by `sid`: a live
 * session opens one per captured audio stream (the call's system audio and
 * the user's microphone), and the ONE loaded recognizer decodes them all.
 *
 * Lifecycle: `open` forks the worker lazily and sends `load`; audio that
 * arrives before `loaded` is dropped (with one `reconnecting` status so the
 * Cue Card shows it). If the worker dies mid-session it is restarted once and
 * every open session's stream reloaded and re-announced; a session that has
 * already been through one restart ends with an error instead.
 */

interface Session {
  sid: number;
  cb: RealtimeSttCallbacks;
  load: LoadMessage;
  loaded: boolean;
  warnedDropping: boolean;
  closed: boolean;
  restarted: boolean;
}

const NOT_INSTALLED =
  'The local speech model is not installed. Download it in Settings → Speech-to-text, or switch back to the cloud engine.';

class SttWorkerHost {
  private child: UtilityProcess | null = null;
  /** Every session the worker still knows about — open ones, and closed ones
   *  waiting for their `stopped` (so a flushed final still lands). */
  private readonly sessions = new Map<number, Session>();
  private nextSid = 1;

  open(cb: RealtimeSttCallbacks, language: string): RealtimeSttSession {
    const prefs = readSttPrefs();
    const model = localSttModel(prefs.localModelId);
    if (!model || !installed(model.id)) throw new Error(NOT_INSTALLED);

    const lang = language.trim().toLowerCase().split(/[-_]/)[0] || null;
    const session: Session = {
      sid: this.nextSid++,
      cb,
      load: loadMessage(model, lang),
      loaded: false,
      warnedDropping: false,
      closed: false,
      restarted: false,
    };
    session.load.sid = session.sid;
    this.sessions.set(session.sid, session);

    this.ensureChild();
    this.post(session.load);

    return {
      appendAudio: (base64Pcm) => this.appendAudio(session, base64Pcm),
      stop: () => this.stop(session),
    };
  }

  private appendAudio(session: Session, base64Pcm: string): void {
    if (session.closed) return;
    if (!session.loaded) {
      if (!session.warnedDropping) {
        session.warnedDropping = true;
        session.cb.onStatus?.('reconnecting'); // "loading model" — frames are dropped until then
      }
      return;
    }
    const pcm = toStandaloneArrayBuffer(Buffer.from(base64Pcm, 'base64'));
    this.post({ type: 'audio', sid: session.sid, pcm });
  }

  private openSessions(): Session[] {
    return [...this.sessions.values()].filter((s) => !s.closed);
  }

  /** Fork the worker and load the selected model BEFORE any session exists,
   *  so the first words of a call are not dropped while ~650 MB loads. Called
   *  whenever the local engine becomes the selection; a no-op mid-session. */
  warmUp(): void {
    if (this.openSessions().length > 0) return;
    const prefs = readSttPrefs();
    const model = localSttModel(prefs.localModelId);
    if (!model || !installed(model.id)) return;
    this.ensureChild();
    this.post(loadMessage(model, null));
  }

  private stop(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (this.child) this.post({ type: 'stop', sid: session.sid });
    else this.sessions.delete(session.sid);
    // Otherwise the session stays registered until 'stopped' so the flushed
    // final still reaches these callbacks.
  }

  private ensureChild(): void {
    if (this.child) return;
    const script = path.join(__dirname, 'stt-worker.js');
    const child = utilityProcess.fork(script, [], {
      serviceName: 'BrainCue local speech-to-text',
      stdio: 'pipe',
    });
    child.stdout?.on('data', (d: Buffer) => log.info(`stt-worker: ${String(d).trim()}`));
    child.stderr?.on('data', (d: Buffer) => log.warn(`stt-worker: ${String(d).trim()}`));
    child.on('message', (m: unknown) => this.onMessage(m as WorkerOut));
    child.on('exit', (code) => this.onExit(child, code));
    this.child = child;
  }

  private post(msg: WorkerIn): void {
    try {
      this.child?.postMessage(msg);
    } catch (e) {
      log.warn('stt-worker: postMessage failed', e);
    }
  }

  private onMessage(m: WorkerOut): void {
    if (m.type === 'ready') return;
    if (m.type === 'error' && m.sid === null) {
      log.error('stt-worker error', m.message);
      return;
    }
    // A warm-up load (sid 0) or a late message from a stream already forgotten.
    const s = this.sessions.get(m.sid ?? -1);
    if (!s) return;
    switch (m.type) {
      case 'loaded':
        if (s.closed) return;
        s.loaded = true;
        s.cb.onStatus?.('connected');
        break;
      case 'delta':
        if (!s.closed) s.cb.onDelta(m.text);
        break;
      case 'final':
        s.cb.onFinal(m.text);
        break;
      case 'stopped':
        this.sessions.delete(s.sid);
        break;
      case 'error':
        log.error('stt-worker error', m.message);
        s.cb.onError?.(`Local transcription error: ${m.message}`);
        if (!s.loaded) {
          // The model could not be loaded — nothing will ever flow.
          s.closed = true;
          s.cb.onStatus?.('disconnected');
          this.sessions.delete(s.sid);
        }
        break;
    }
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (this.child !== child) return;
    this.child = null;
    // Sessions that were only waiting for their `stopped` will never get it.
    for (const s of [...this.sessions.values()]) if (s.closed) this.sessions.delete(s.sid);
    const open = this.openSessions();
    if (open.length === 0) {
      if (code !== 0) log.warn(`stt-worker exited with code ${code}`);
      return;
    }
    // Restart ONCE per session: every open stream is reloaded and re-announced
    // on the new process; a session that already survived one death gives up.
    const survivors = open.filter((s) => !s.restarted);
    for (const s of open.filter((s) => s.restarted)) {
      log.error(`stt-worker exited again (code ${code}); giving up on stream ${s.sid}`);
      s.closed = true;
      this.sessions.delete(s.sid);
      s.cb.onError?.('Local transcription stopped unexpectedly. Please restart the session.');
      s.cb.onStatus?.('disconnected');
    }
    if (survivors.length === 0) return;
    log.warn(`stt-worker exited (code ${code}) mid-session — restarting once`);
    this.ensureChild();
    for (const s of survivors) {
      s.restarted = true;
      s.loaded = false;
      s.cb.onStatus?.('reconnecting');
      this.post(s.load);
    }
  }
}

/** The `load` message for a catalog model. `sid` 0 = a warm-up load that
 *  belongs to no session; open() rewrites it with the session id. */
function loadMessage(model: LocalSttModel, language: string | null): LoadMessage {
  const dir = modelDir(model.id);
  const byName = (n: string): string => path.join(dir, n);
  return {
    type: 'load',
    sid: 0,
    modelDir: dir,
    files: {
      encoder: byName('encoder.int8.onnx'),
      decoder: byName('decoder.int8.onnx'),
      joiner: byName('joiner.int8.onnx'),
      tokens: byName('tokens.txt'),
    },
    language,
    multilingual: model.languages === 'multilingual',
  };
}

const host = new SttWorkerHost();

/** Pre-load the selected local model (see SttWorkerHost.warmUp). */
export function warmLocalStt(): void {
  host.warmUp();
}

export const localRealtimeStt: RealtimeSttProvider = {
  open(cb, opts) {
    return host.open(cb, opts.language);
  },
};

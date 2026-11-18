import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review finding: audio startup could report success when capture failed.
 *  - an acquisition failure returned normally, so the start modal closed;
 *  - an attach failure (AudioContext) was swallowed into a notice, leaving
 *    the session marked live with no pipeline and the streams held open;
 *  - the capture status was reported BEFORE the pipeline was attached.
 * The store now returns an explicit StartResult and rolls back on failure.
 */
const h = vi.hoisted(() => ({
  calls: [] as string[],
  savePrompt: null as null | ((p: unknown) => void),
  sessionState: null as null | ((p: unknown) => void),
  stopFails: 0, // how many stop calls reject before one succeeds
  deleteFails: false,
  startFails: false,
  ctxFails: false,
  displayFails: false,
  micFails: false,
  tracks: [] as { stop: ReturnType<typeof vi.fn>; readyState: string }[],
}));

vi.mock('../lib/api', () => ({
  api: {
    events: {
      onTranscriptDelta: () => () => {},
      onQuestionDetected: () => () => {},
      onSavePrompt: (cb: (p: unknown) => void) => {
        h.savePrompt = cb;
        return () => {};
      },
      onSessionError: () => () => {},
      onSessionState: (cb: (p: unknown) => void) => {
        h.sessionState = cb;
        return () => {};
      },
    },
    session: {
      start: async () => {
        h.calls.push('start');
        if (h.startFails) throw new Error('No AI provider is set up');
        return { id: 's-new' };
      },
      resume: async (id: string) => {
        h.calls.push('resume');
        return { id };
      },
      // Like main (engine.stop): a successful stop broadcasts the stopped state
      // and the save prompt BEFORE the call returns.
      stop: async (id: string) => {
        h.calls.push(`stop:${id}`);
        if (h.stopFails > 0) {
          h.stopFails--;
          throw new Error('IPC stop failed');
        }
        h.sessionState?.({ status: 'stopped', paused: false });
        h.savePrompt?.({ sessionId: id });
      },
      delete: async (id: string) => {
        h.calls.push(`delete:${id}`);
        if (h.deleteFails) throw new Error('IPC delete failed');
      },
      reportCapture: async (st: { system: boolean; mic: boolean }) => h.calls.push(`report:${st.system}/${st.mic}`),
      sendRealtimeAudio: () => {},
    },
  },
}));

/** 'ended' listeners per source, so a test can end a track mid-session. */
const ended: Record<string, (() => void)[]> = { display: [], mic: [] };

function stream(kind: 'display' | 'mic') {
  const audio = {
    stop: vi.fn(),
    readyState: 'live',
    addEventListener: (ev: string, cb: () => void) => ev === 'ended' && ended[kind].push(cb),
    kind: 'audio',
  };
  const video = { stop: vi.fn(), readyState: 'live', addEventListener: vi.fn(), kind: 'video' };
  h.tracks.push(audio, ...(kind === 'display' ? [video] : []));
  const all = kind === 'display' ? [audio, video] : [audio];
  return {
    getTracks: () => all,
    getAudioTracks: () => [audio],
    getVideoTracks: () => (kind === 'display' ? [video] : []),
  };
}

vi.stubGlobal('navigator', {
  mediaDevices: {
    getDisplayMedia: async () => {
      if (h.displayFails) throw new Error('Permission denied');
      return stream('display');
    },
    getUserMedia: async () => {
      if (h.micFails) throw new Error('Permission denied');
      return stream('mic');
    },
  },
});
vi.stubGlobal(
  'AudioContext',
  class {
    destination = {};
    async resume() {
      if (h.ctxFails) throw new Error('AudioContext was not allowed to start');
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => {} };
    }
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    createScriptProcessor() {
      h.calls.push('pump');
      return { connect: () => {}, disconnect: () => {}, onaudioprocess: null };
    }
    async close() {}
  },
);
vi.stubGlobal('window', { api: {} });

import { useLiveSession } from './useLiveSession';

const startArgs = { profileId: 'p1', answerFormat: 'general', jobId: 'j1', activity: 'job', listensTo: 'system' as const };

beforeEach(() => {
  h.calls.length = 0;
  h.tracks.length = 0;
  h.startFails = h.ctxFails = h.displayFails = h.micFails = h.deleteFails = false;
  h.stopFails = 0;
  ended.display.length = 0;
  ended.mic.length = 0;
  useLiveSession.setState({ session: null, micError: null, sessionError: null, pendingSave: null });
});

describe('start reports what actually happened', () => {
  it('success: the pipeline is attached BEFORE capture status is reported', async () => {
    const r = await useLiveSession.getState().startNew(startArgs);
    expect(r).toEqual({ ok: true, sessionId: 's-new' });
    expect(h.calls).toEqual(['start', 'pump', 'pump', 'report:true/true']);
    expect(useLiveSession.getState().session?.id).toBe('s-new');
  });

  it('no audio at all: an explicit failure, and no session is created', async () => {
    h.displayFails = true;
    h.micFails = true;
    const r = await useLiveSession.getState().startNew(startArgs);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.stage).toBe('capture');
    expect(h.calls).not.toContain('start');
  });

  it('the audio pipeline fails to attach: the session is stopped and deleted, the streams released', async () => {
    h.ctxFails = true;
    const r = await useLiveSession.getState().startNew(startArgs);
    expect(r).toMatchObject({ ok: false, stage: 'audio' });
    expect(r.ok === false && r.error).toMatch(/AudioContext was not allowed to start/);
    expect(h.calls).toEqual(['start', 'stop:s-new', 'delete:s-new']); // never reported as capturing
    expect(h.tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    const st = useLiveSession.getState();
    expect(st.session).toBeNull();
    // The rollback's own save prompt (broadcast during its stop) is not offered.
    expect(st.pendingSave).toBeNull();
    expect(r.ok === false && r.cleanup).toBeUndefined(); // cleanup confirmed
    expect(st.micError).toMatch(/stopped and removed — nothing was recorded/);
  });

  it('the session fails to open: the acquired streams are released', async () => {
    h.startFails = true;
    const r = await useLiveSession.getState().startNew(startArgs);
    expect(r).toMatchObject({ ok: false, stage: 'start', error: 'No AI provider is set up' });
    expect(h.tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(useLiveSession.getState().sessionError).toBe('No AI provider is set up');
  });

  it('a resumed session whose audio fails is stopped but NOT deleted (it has earlier content)', async () => {
    h.ctxFails = true;
    const r = await useLiveSession.getState().resumeExisting({ sessionId: 's-old', listensTo: 'system', prior: [] });
    expect(r).toMatchObject({ ok: false, stage: 'audio' });
    expect(h.calls).toEqual(['resume', 'stop:s-old']);
  });

  it('a share that ends during setup is not reported as live', async () => {
    const real = navigator.mediaDevices.getDisplayMedia;
    (navigator.mediaDevices as { getDisplayMedia: unknown }).getDisplayMedia = async () => {
      const s = stream('display');
      s.getAudioTracks()[0].readyState = 'ended';
      return s;
    };
    const r = await useLiveSession.getState().startNew(startArgs);
    (navigator.mediaDevices as { getDisplayMedia: unknown }).getDisplayMedia = real;
    expect(r.ok).toBe(true); // the microphone still flows
    expect(h.calls.at(-1)).toBe('report:false/true');
  });
it('picker cancelled (or no display audio) but the mic works: the session runs and NAMES the missing stream', async () => {
    h.displayFails = true;
    const r = await useLiveSession.getState().startNew(startArgs);
    expect(r.ok).toBe(true);
    expect(useLiveSession.getState().micError).toMatch(/System audio was not captured/);
    expect(h.calls.at(-1)).toBe('report:false/true');
  });

  it('no microphone device but the call is captured: runs, names the missing stream', async () => {
    h.micFails = true;
    const r = await useLiveSession.getState().startNew(startArgs);
    expect(r.ok).toBe(true);
    expect(useLiveSession.getState().micError).toMatch(/Microphone access was denied/);
    expect(h.calls.at(-1)).toBe('report:true/false');
  });

  it('a track ending mid-session is reported truthfully, with what it means', async () => {
    await useLiveSession.getState().startNew(startArgs);
    for (const cb of ended.display) cb();
    expect(h.calls.at(-1)).toBe('report:false/true');
    expect(useLiveSession.getState().micError).toMatch(/call audio stopped/);
    expect(useLiveSession.getState().session?.id).toBe('s-new'); // still live: the mic flows
  });
});


describe('M1 review round 2: rollback claims only what it confirmed', () => {
  it('fail resume → successful resume → normal stop: the save prompt appears (suppression is one-shot)', async () => {
    h.ctxFails = true;
    const failed = await useLiveSession.getState().resumeExisting({ sessionId: 's-old', listensTo: 'system', prior: [] });
    expect(failed).toMatchObject({ ok: false, stage: 'audio' });
    expect(useLiveSession.getState().pendingSave).toBeNull(); // the failed attempt: no prompt

    h.ctxFails = false;
    const retried = await useLiveSession.getState().resumeExisting({ sessionId: 's-old', listensTo: 'system', prior: [] });
    expect(retried).toEqual({ ok: true, sessionId: 's-old' });
    await useLiveSession.getState().stop();
    expect(useLiveSession.getState().pendingSave).toEqual({ sessionId: 's-old' });
  });

  it('the same for a NEW session id that is started again later', async () => {
    h.ctxFails = true;
    await useLiveSession.getState().startNew(startArgs);
    h.ctxFails = false;
    await useLiveSession.getState().startNew(startArgs); // the fake reuses the id
    await useLiveSession.getState().stop();
    expect(useLiveSession.getState().pendingSave).toEqual({ sessionId: 's-new' });
  });

  for (const kind of ['new', 'resumed'] as const) {
    it(`${kind} session: a rejected stop is NOT reported as stopped; the session stays and Stop retries the rollback`, async () => {
      h.ctxFails = true;
      h.stopFails = 1;
      const r =
        kind === 'new'
          ? await useLiveSession.getState().startNew(startArgs)
          : await useLiveSession.getState().resumeExisting({ sessionId: 's-old', listensTo: 'system', prior: [] });
      const id = kind === 'new' ? 's-new' : 's-old';
      expect(r).toMatchObject({ ok: false, stage: 'audio', cleanup: 'failed' });
      expect(r.ok === false && r.error).toMatch(/Stopping the session failed .* may still be running/);
      expect(r.ok === false && r.error).not.toMatch(/was stopped/);
      expect(h.calls).not.toContain(`delete:${id}`); // never delete before teardown is confirmed
      expect(useLiveSession.getState().session?.id).toBe(id); // still visible, still stoppable

      // Retry via the normal Stop: the same rollback, confirmed this time.
      await useLiveSession.getState().stop();
      expect(h.calls.filter((c) => c === `stop:${id}`)).toHaveLength(2);
      expect(h.calls.includes(`delete:${id}`)).toBe(kind === 'new');
      expect(useLiveSession.getState().session).toBeNull();
      expect(useLiveSession.getState().pendingSave).toBeNull(); // still the failed attempt
    });
  }

  it('a Stop retry that fails again stays visible and throws', async () => {
    h.ctxFails = true;
    h.stopFails = 2;
    await useLiveSession.getState().startNew(startArgs);
    await expect(useLiveSession.getState().stop()).rejects.toThrow(/may still be running/);
    expect(useLiveSession.getState().session?.id).toBe('s-new');
    expect(useLiveSession.getState().micError).toMatch(/Stopping the session failed/);
  });

  it('stopped but the delete fails: says exactly that, never "nothing was recorded"', async () => {
    h.ctxFails = true;
    h.deleteFails = true;
    const r = await useLiveSession.getState().startNew(startArgs);
    expect(r).toMatchObject({ ok: false, stage: 'audio', cleanup: 'failed' });
    expect(r.ok === false && r.error).toMatch(/was stopped, but its empty record couldn't be removed .* delete it from Sessions/);
    expect(r.ok === false && r.error).not.toMatch(/nothing was recorded/);
    expect(useLiveSession.getState().session).toBeNull(); // it IS stopped (confirmed)
  });
});

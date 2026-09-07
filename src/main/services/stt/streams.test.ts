import { describe, expect, it } from 'vitest';
import { StreamTable } from './streams';
import type { OnlineRecognizer, OnlineStream } from './streams';
import type { WorkerOut } from './protocol';

/**
 * The worker's stream table, driven with a scripted recognizer (no addon):
 * two streams — the call and the user's microphone — decode on the one
 * recognizer at the same time, and their deltas, endpoints and finals never
 * cross. This is the pure part of worker.ts; the process wiring around it is
 * two `switch` cases.
 */

interface FakeStream extends OnlineStream {
  /** What `getResult` returns next — the test scripts it per stream. */
  text: string;
  endpoint: boolean;
  finished: boolean;
  frames: number;
  resets: number;
}

function fakeRecognizer(): OnlineRecognizer & { streams: FakeStream[] } {
  const streams: FakeStream[] = [];
  return {
    streams,
    createStream() {
      const s: FakeStream = {
        text: '',
        endpoint: false,
        finished: false,
        frames: 0,
        resets: 0,
        acceptWaveform() {
          s.frames += 1;
        },
        inputFinished() {
          s.finished = true;
        },
        setOption() {},
      };
      streams.push(s);
      return s;
    },
    // One decode per frame, then not ready — enough to prove the loop runs.
    isReady: (s) => (s as FakeStream).frames > 0 && !(s as { decoded?: boolean }).decoded,
    decode: (s) => {
      (s as { decoded?: boolean }).decoded = true;
    },
    isEndpoint: (s) => (s as FakeStream).endpoint,
    reset: (s) => {
      const f = s as FakeStream;
      f.resets += 1;
      f.text = '';
      f.endpoint = false;
    },
    getResult: (s) => ({ text: (s as FakeStream).text }),
  };
}

/** A frame of PCM16 silence (any content decodes to whatever the fake says). */
const frame = (): ArrayBuffer => new ArrayBuffer(960 * 2);

function setup() {
  const out: WorkerOut[] = [];
  const table = new StreamTable((m) => out.push(m));
  const rec = fakeRecognizer();
  const call = rec.createStream() as FakeStream;
  const mic = rec.createStream() as FakeStream;
  table.open(1, call, null);
  table.open(2, mic, null);
  return { out, table, rec, call, mic };
}

describe('StreamTable — two streams on one recognizer', () => {
  it('routes each frame to the stream of its sid and publishes incremental deltas per stream', () => {
    const { out, table, rec, call, mic } = setup();
    call.text = 'what is the';
    expect(table.audio(rec, 1, frame())).toBe(true);
    mic.text = 'I think';
    expect(table.audio(rec, 2, frame())).toBe(true);
    call.text = 'what is the budget';
    table.audio(rec, 1, frame());

    expect(call.frames).toBe(2);
    expect(mic.frames).toBe(1);
    expect(out).toEqual([
      { type: 'delta', sid: 1, text: 'what is the' },
      { type: 'delta', sid: 2, text: 'I think' },
      { type: 'delta', sid: 1, text: ' budget' }, // only what was added — consumers append
    ]);
  });

  it('keeps "last text" per stream, so an unchanged result on one stream is not re-sent', () => {
    const { out, table, rec, call, mic } = setup();
    call.text = 'hello';
    table.audio(rec, 1, frame());
    mic.text = 'hello'; // same words on the OTHER stream still count as a change there
    table.audio(rec, 2, frame());
    table.audio(rec, 1, frame()); // call unchanged → nothing
    expect(out.filter((m) => m.type === 'delta')).toEqual([
      { type: 'delta', sid: 1, text: 'hello' },
      { type: 'delta', sid: 2, text: 'hello' },
    ]);
  });

  it('an endpoint on one stream finals and resets THAT stream only', () => {
    const { out, table, rec, call, mic } = setup();
    mic.text = 'I was going to say';
    table.audio(rec, 2, frame());
    call.text = 'what is the budget?';
    call.endpoint = true;
    table.audio(rec, 1, frame());

    expect(out.at(-1)).toEqual({ type: 'final', sid: 1, text: 'what is the budget?' });
    expect(call.resets).toBe(1);
    expect(mic.resets).toBe(0);
    // The mic's in-flight text survives the call's endpoint: its next frame
    // with the same text is NOT re-sent as a delta (lastText intact)...
    table.audio(rec, 2, frame());
    expect(out.filter((m) => m.type === 'delta' && m.sid === 2)).toHaveLength(1);
    // ...and the call starts a fresh utterance from empty.
    call.text = 'and';
    table.audio(rec, 1, frame());
    expect(out.at(-1)).toEqual({ type: 'delta', sid: 1, text: 'and' });
  });

  it('stop flushes only its own stream and forgets it; the other keeps decoding', () => {
    const { out, table, rec, call, mic } = setup();
    mic.text = 'that is all from me';
    table.stop(rec, 2);
    expect(mic.finished).toBe(true);
    expect(out).toEqual([
      { type: 'final', sid: 2, text: 'that is all from me' },
      { type: 'stopped', sid: 2 },
    ]);
    expect(table.has(2)).toBe(false);
    expect(table.has(1)).toBe(true);
    expect(call.finished).toBe(false);

    // Frames for the stopped stream are dropped, not misrouted.
    expect(table.audio(rec, 2, frame())).toBe(false);
    expect(mic.frames).toBe(0);
    call.text = 'still here';
    table.audio(rec, 1, frame());
    expect(out.at(-1)).toEqual({ type: 'delta', sid: 1, text: 'still here' });
  });

  it('stop answers `stopped` for an unknown sid and without a recognizer', () => {
    const out: WorkerOut[] = [];
    const table = new StreamTable((m) => out.push(m));
    table.stop(null, 7);
    table.stop(fakeRecognizer(), 8);
    expect(out).toEqual([
      { type: 'stopped', sid: 7 },
      { type: 'stopped', sid: 8 },
    ]);
  });

  it('a silent stop (no text) still settles with `stopped`', () => {
    const { out, table, rec } = setup();
    table.stop(rec, 1);
    expect(out).toEqual([{ type: 'stopped', sid: 1 }]);
  });

  it('re-opening a sid replaces its stream (worker restart re-sends every load)', () => {
    const { table, rec } = setup();
    const fresh = rec.createStream() as FakeStream;
    table.open(1, fresh, null);
    fresh.text = 'after restart';
    table.audio(rec, 1, frame());
    expect(fresh.frames).toBe(1);
    expect(table.size).toBe(2);
    expect(table.sids().sort()).toEqual([1, 2]);
  });
});

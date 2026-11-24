// PERF-01 live benchmark: the budget meter's pure core. This is test
// infrastructure and never part of the app.
//
// The meter (live-meter.cjs) runs in the app's MAIN process during the live
// benchmark only. Before each provider request is sent, it RESERVES a
// conservative upper bound on what that request can cost. If the reservation
// would cross a cap, the request is refused instead of sent. The ledger lives
// in one folder for the whole run, so every app process (warm blocks, cold
// starts, setup) draws on the same budget.
//
// Nothing here touches the network or installs a hook: the tests import it
// directly (src/main/services/engine/bench/perf01.meter.test.ts).
'use strict';
const fs = require('fs');
const path = require('path');

/** A request with no output ceiling is charged as if it used this much. */
const UNBOUNDED_COMPLETION = 8192;
/** English JSON is about 4 bytes per token; charging 1 token per 3 bytes
 *  over-reserves the prompt, never under-reserves it. */
const BYTES_PER_TOKEN = 3;
/** PCM16 mono at 24 kHz: 48,000 bytes per second of audio. */
const PCM_BYTES_PER_SECOND = 24000 * 2;

/** What kind of provider request a path is. */
function requestClass(method, pathname) {
  const p = String(pathname || '').split('?')[0];
  if (/\/realtime$/.test(p)) return 'realtime-connect';
  if (/\/embeddings$/.test(p)) return 'embedding';
  if (/\/responses$/.test(p)) return 'responses';
  if (/\/chat\/completions$/.test(p)) return 'chat';
  if (/\/models(\/|$)/.test(p)) return 'models';
  return String(method || 'GET').toUpperCase() === 'GET' ? 'get' : 'other';
}

/** The conservative reservation for one request, from what is about to be
 *  sent: prompt = body bytes / 3, completion = the body's own output ceiling
 *  (or UNBOUNDED_COMPLETION when it has none). Only the model id is read
 *  from the body; nothing else in it is kept. */
function reservationFor({ method, path: pathname, body }) {
  const cls = requestClass(method, pathname);
  const text = body == null ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  const bytes = Buffer.byteLength(text);
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null; // multipart or other: reserved by size, unbounded completion
    }
  }
  const model = parsed && typeof parsed.model === 'string' ? parsed.model : null;
  const ceiling = parsed
    ? [parsed.max_output_tokens, parsed.max_completion_tokens, parsed.max_tokens].find((v) => typeof v === 'number')
    : undefined;
  const noCompletion = cls === 'embedding' || cls === 'models' || cls === 'realtime-connect' || cls === 'get';
  const completionTokens = noCompletion ? 0 : ceiling !== undefined ? ceiling : UNBOUNDED_COMPLETION;
  return {
    cls,
    model,
    bytes,
    promptTokens: Math.ceil(bytes / BYTES_PER_TOKEN),
    completionTokens,
    unbounded: !noCompletion && ceiling === undefined,
  };
}

/** Seconds of 24 kHz PCM16 audio in a base64 string. */
function audioSeconds(base64) {
  const len = String(base64 || '').length;
  const padding = /==$/.test(base64) ? 2 : /=$/.test(base64) ? 1 : 0;
  return Math.max(0, (len * 3) / 4 - padding) / PCM_BYTES_PER_SECOND;
}

/** Caps from the environment. A missing or unreadable cap is 0: the meter
 *  fails closed, so a run without caps sends nothing. */
function capsFromEnv(env) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : 0;
  };
  return {
    tokens: n(env.PERF01_CAP_TOKENS),
    requests: n(env.PERF01_CAP_REQUESTS),
    sttSeconds: n(env.PERF01_CAP_STT_SECONDS),
  };
}

function providerHosts(env) {
  return String(env.PERF01_PROVIDER_HOSTS || 'api.openai.com')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function emptyState() {
  return {
    version: 1,
    reservedTokens: 0,
    reservedPromptTokens: 0,
    reservedCompletionTokens: 0,
    requests: 0,
    refused: 0,
    unboundedRequests: 0,
    sttSeconds: 0,
    byClass: {},
    models: {},
    stt: null,
    capped: null,
    processes: [],
  };
}

const STATE = 'meter.json';
const REQUESTS = 'requests.jsonl';

function load(dir) {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(path.join(dir, STATE), 'utf8').replace(/^﻿/, '')) };
  } catch {
    return emptyState();
  }
}

/** Written whole and renamed into place, so a reader never sees half a file. */
function save(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${STATE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, path.join(dir, STATE));
}

function logRequest(dir, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, REQUESTS), JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + '\n');
  } catch {
    /* the log is evidence, never a reason to crash the app */
  }
}

/** May this reservation be sent? Once a cap has refused anything the meter
 *  stays capped: the run is over, and nothing later slips under the cap. */
function decide(state, caps, r) {
  if (state.capped) return { ok: false, reason: `capped (${state.capped.reason})` };
  if (state.requests + 1 > caps.requests) return { ok: false, reason: 'requests' };
  if (state.reservedTokens + r.promptTokens + r.completionTokens > caps.tokens) return { ok: false, reason: 'tokens' };
  return { ok: true };
}

function decideAudio(state, caps, seconds) {
  if (state.capped) return { ok: false, reason: `capped (${state.capped.reason})` };
  if (state.sttSeconds + seconds > caps.sttSeconds) return { ok: false, reason: 'stt-seconds' };
  return { ok: true };
}

/** Apply a decision to the state (the caller saves it). */
function commit(state, r, verdict) {
  if (!verdict.ok) {
    state.refused += 1;
    if (!state.capped) state.capped = { reason: verdict.reason, cls: r.cls, at: Date.now() };
    return state;
  }
  state.requests += 1;
  state.reservedPromptTokens += r.promptTokens;
  state.reservedCompletionTokens += r.completionTokens;
  state.reservedTokens += r.promptTokens + r.completionTokens;
  if (r.unbounded) state.unboundedRequests += 1;
  state.byClass[r.cls] = (state.byClass[r.cls] || 0) + 1;
  if (r.model) state.models[r.model] = (state.models[r.model] || 0) + 1;
  return state;
}

function commitAudio(state, seconds, verdict) {
  if (!verdict.ok) {
    state.refused += 1;
    if (!state.capped) state.capped = { reason: verdict.reason, cls: 'stt-audio', at: Date.now() };
    return state;
  }
  state.sttSeconds += seconds;
  return state;
}

/** The transcription settings from a realtime session.update, without any
 *  other field of the message. */
function sttConfig(message) {
  const input = message && message.session && message.session.audio && message.session.audio.input;
  if (!input) return null;
  const t = input.transcription || {};
  const v = input.turn_detection || {};
  return {
    model: typeof t.model === 'string' ? t.model : null,
    vad: v.type || null,
    prefixPaddingMs: typeof v.prefix_padding_ms === 'number' ? v.prefix_padding_ms : null,
    silenceDurationMs: typeof v.silence_duration_ms === 'number' ? v.silence_duration_ms : null,
    rate: input.format && typeof input.format.rate === 'number' ? input.format.rate : null,
  };
}

module.exports = {
  UNBOUNDED_COMPLETION,
  BYTES_PER_TOKEN,
  requestClass,
  reservationFor,
  audioSeconds,
  capsFromEnv,
  providerHosts,
  emptyState,
  load,
  save,
  logRequest,
  decide,
  decideAudio,
  commit,
  commitAudio,
  sttConfig,
  STATE,
  REQUESTS,
};

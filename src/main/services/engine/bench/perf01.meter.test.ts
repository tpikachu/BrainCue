import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

/**
 * PERF-01 budget meter (scripts/perf01/live-meter.cjs), OFFLINE.
 *
 * Each case runs a real child Node process with the meter loaded the way the
 * live run loads it (`--require`). The child uses the app's real transports
 * (the OpenAI SDK and `ws`) against a fake provider on loopback. The
 * assertions are on what the fake provider actually RECEIVED, so a refused
 * request is proven never to have been sent. No real provider is contacted.
 */
const ROOT = process.cwd();
const METER = path.join(ROOT, 'scripts', 'perf01', 'live-meter.cjs');
const core = createRequire(import.meta.url)(path.join(ROOT, 'scripts', 'perf01', 'meter-core.cjs'));

let server: Server;
let port = 0;
let received: { method: string; url: string; bytes: number }[] = [];
let audioFrames = 0;

const CHILD = `
const actions = JSON.parse(process.argv[2]);
const base = process.argv[3];
const OpenAI = require(require.resolve('openai', { paths: [${JSON.stringify(ROOT)}] }));
const WebSocket = require(require.resolve('ws', { paths: [${JSON.stringify(ROOT)}] }));
const client = new OpenAI({ apiKey: 'test', baseURL: base + '/v1', maxRetries: 0, timeout: 5000 });
const out = [];
(async () => {
  for (const a of actions) {
    try {
      if (a.kind === 'json') {
        const r = await client.responses.create({ model: 'gpt-6-luna', input: [{ role: 'user', content: a.text }], ...(a.ceiling ? { max_output_tokens: a.ceiling } : {}) });
        out.push({ ok: true, kind: a.kind, text: r.output_text });
      } else if (a.kind === 'embed') {
        await client.embeddings.create({ model: 'text-embedding-3-small', input: a.text });
        out.push({ ok: true, kind: a.kind });
      } else if (a.kind === 'models') {
        await client.models.retrieve('gpt-6-luna');
        out.push({ ok: true, kind: a.kind });
      } else if (a.kind === 'http-other') {
        try { require('http').get('http://example.invalid/'); out.push({ ok: true, kind: a.kind }); }
        catch (e) { out.push({ ok: false, kind: a.kind, code: e.code }); }
      } else if (a.kind === 'socket-other') {
        await new Promise((res) => {
          const s = require('net').connect(80, '10.255.255.1');
          s.on('error', (e) => { out.push({ ok: false, kind: a.kind, code: e.code }); res(); });
          s.on('connect', () => { out.push({ ok: true, kind: a.kind }); s.destroy(); res(); });
        });
      } else if (a.kind === 'stt') {
        await new Promise((res, rej) => {
          const ws = new WebSocket(base.replace('http', 'ws') + '/v1/realtime?intent=transcription');
          ws.on('error', rej);
          ws.on('open', async () => {
            ws.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-4o-transcribe', language: 'en' }, turn_detection: { type: 'server_vad', prefix_padding_ms: 300, silence_duration_ms: 600 } } } } }));
            const second = Buffer.alloc(48000).toString('base64');
            let refused = 0;
            for (let i = 0; i < a.seconds; i++) {
              await new Promise((r) => ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: second }), (err) => { if (err) refused++; r(); }));
            }
            setTimeout(() => { ws.close(); out.push({ ok: true, kind: a.kind, refused }); res(); }, 200);
          });
        });
      }
    } catch (e) {
      out.push({ ok: false, kind: a.kind, error: String(e && e.message || e) });
    }
  }
  process.stdout.write(JSON.stringify(out));
})();
`;

let work = '';
let child = '';

function run(actions: unknown[], env: Record<string, string>): Promise<{ ok: boolean; kind: string; code?: string; error?: string; refused?: number; text?: string }[]> {
  return new Promise((resolve, reject) => {
    const e: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require "${METER.split('\\').join('/')}"`, PERF01_PROVIDER_HOSTS: '127.0.0.1', ...env };
    delete e.ELECTRON_RUN_AS_NODE;
    execFile(process.execPath, [child, JSON.stringify(actions), `http://127.0.0.1:${port}`], { env: e, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`${err.message}\n${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`child output: ${stdout}\n${stderr}`));
      }
    });
  });
}

const ledger = (dir: string) => core.load(dir);
const requests = (dir: string) =>
  existsSync(path.join(dir, core.REQUESTS))
    ? readFileSync(path.join(dir, core.REQUESTS), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'perf01-meter-'));
  child = path.join(work, 'child.cjs');
  writeFileSync(child, CHILD);
  server = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => (bytes += c.length));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', bytes });
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/v1/responses'))
        res.end(JSON.stringify({ id: 'r', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 5, output_tokens: 2 } }));
      else if (req.url?.startsWith('/v1/embeddings')) res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3, total_tokens: 3 } }));
      else res.end(JSON.stringify({ id: 'gpt-6-luna', object: 'model' }));
    });
  });
  const wss = new WebSocketServer({ server, path: '/v1/realtime' });
  wss.on('connection', (ws) =>
    ws.on('message', (m) => {
      if (String(m).includes('input_audio_buffer.append')) audioFrames++;
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server?.close();
  rmSync(work, { recursive: true, force: true });
});

let dir = '';
let caseNo = 0;
beforeEach(() => {
  received = [];
  audioFrames = 0;
  dir = path.join(work, `ledger-${++caseNo}`);
});

const caps = (tokens: number, requests = 100, sttSeconds = 100) => ({
  PERF01_LEDGER: dir,
  PERF01_CAP_TOKENS: String(tokens),
  PERF01_CAP_REQUESTS: String(requests),
  PERF01_CAP_STT_SECONDS: String(sttSeconds),
});

describe('PERF-01 budget meter (real SDK and ws, fake loopback provider)', () => {
  it('a request within the cap is sent; its reservation is bytes/3 + its own output ceiling', async () => {
    const out = await run([{ kind: 'json', text: 'hello', ceiling: 2 }], caps(10_000));
    expect(out[0]).toMatchObject({ ok: true, text: 'ok' });
    expect(received).toHaveLength(1);
    const l = ledger(dir);
    expect(l.requests).toBe(1);
    expect(l.reservedTokens).toBe(Math.ceil(received[0].bytes / 3) + 2);
    expect(l.capped).toBeNull();
    expect(l.models).toEqual({ 'gpt-6-luna': 1 });
  });

  it('the review case: a one-token cap and an answer that could use two tokens is refused BEFORE it is sent', async () => {
    const out = await run([{ kind: 'json', text: 'hello', ceiling: 2 }, { kind: 'embed', text: 'x' }], caps(1));
    expect(out.map((o) => o.ok)).toEqual([false, false]); // the later, tiny request is refused too: capped
    expect(received).toHaveLength(0); // nothing reached the provider
    const l = ledger(dir);
    expect(l.capped).toMatchObject({ reason: 'tokens', cls: 'responses' });
    expect(l.requests).toBe(0);
    expect(l.refused).toBe(2);
    expect(requests(dir).map((r) => r.refused)).toEqual(['tokens', 'capped (tokens)']);
  });

  it('the final request of a block that would cross the cap is refused; the ones before it went', async () => {
    const one = core.reservationFor({ method: 'POST', path: '/v1/responses', body: JSON.stringify({ model: 'gpt-6-luna', input: [{ role: 'user', content: 'q' }], max_output_tokens: 50 }) });
    const per = one.promptTokens + one.completionTokens;
    const out = await run(
      [1, 2, 3].map(() => ({ kind: 'json', text: 'q', ceiling: 50 })),
      caps(per * 2 + Math.floor(per / 2)),
    );
    expect(out.map((o) => o.ok)).toEqual([true, true, false]);
    expect(received).toHaveLength(2);
    expect(ledger(dir).capped).toMatchObject({ reason: 'tokens' });
  });

  it('the budget accumulates across app processes (blocks): a second process cannot overspend', async () => {
    const one = core.reservationFor({ method: 'POST', path: '/v1/responses', body: JSON.stringify({ model: 'gpt-6-luna', input: [{ role: 'user', content: 'a' }], max_output_tokens: 20 }) });
    const env = caps(Math.floor((one.promptTokens + one.completionTokens) * 1.5));
    const first = await run([{ kind: 'json', text: 'a', ceiling: 20 }], env);
    const second = await run([{ kind: 'json', text: 'b', ceiling: 20 }], env);
    expect(first[0].ok).toBe(true);
    expect(second[0].ok).toBe(false);
    expect(received).toHaveLength(1);
    const l = ledger(dir);
    expect(l.processes).toHaveLength(2);
    expect(l.capped).toMatchObject({ reason: 'tokens' });
  });

  it('a request without an output ceiling is reserved as unbounded (8,192); setup and auxiliary calls count too', async () => {
    const out = await run([{ kind: 'json', text: 'parse this JD' }, { kind: 'embed', text: 'résumé chunk' }, { kind: 'models' }], caps(100_000));
    expect(out.every((o) => o.ok)).toBe(true);
    const l = ledger(dir);
    expect(l.byClass).toEqual({ responses: 1, embedding: 1, models: 1 });
    expect(l.unboundedRequests).toBe(1);
    const [json, embed, models] = requests(dir);
    expect(json).toMatchObject({ cls: 'responses', reservedCompletionTokens: core.UNBOUNDED_COMPLETION, unbounded: true, sent: true });
    expect(embed).toMatchObject({ cls: 'embedding', reservedCompletionTokens: 0, model: 'text-embedding-3-small' });
    expect(models).toMatchObject({ cls: 'models', reservedPromptTokens: 0 });
  });

  it('the request-count cap holds whatever the tokens', async () => {
    const out = await run([{ kind: 'embed', text: 'a' }, { kind: 'embed', text: 'b' }], caps(100_000, 1));
    expect(out.map((o) => o.ok)).toEqual([true, false]);
    expect(received).toHaveLength(1);
    expect(ledger(dir).capped).toMatchObject({ reason: 'requests' });
  });

  it('fails closed: with no caps set, nothing is sent', async () => {
    const out = await run([{ kind: 'embed', text: 'a' }], { PERF01_LEDGER: dir });
    expect(out[0].ok).toBe(false);
    expect(received).toHaveLength(0);
  });

  it('any host but the provider is refused (http and raw sockets); nothing leaves', async () => {
    const out = await run([{ kind: 'http-other' }, { kind: 'socket-other' }], caps(100_000));
    expect(out).toEqual([
      { ok: false, kind: 'http-other', code: 'ECONNREFUSED' },
      { ok: false, kind: 'socket-other', code: 'ECONNREFUSED' },
    ]);
    expect(requests(dir).map((r) => r.refused)).toEqual(['host-not-allowed', 'host-not-allowed']);
  });

  it('speech-to-text audio is metered by the second; past the cap it is not sent; the STT model and VAD are recorded', async () => {
    const out = await run([{ kind: 'stt', seconds: 5 }], caps(100_000, 100, 3));
    expect(out[0]).toMatchObject({ ok: true, refused: 2 });
    expect(audioFrames).toBe(3);
    const l = ledger(dir);
    expect(l.sttSeconds).toBeCloseTo(3, 5);
    expect(l.capped).toMatchObject({ reason: 'stt-seconds', cls: 'stt-audio' });
    expect(l.stt).toMatchObject({ model: 'gpt-4o-transcribe', vad: 'server_vad', prefixPaddingMs: 300, silenceDurationMs: 600, rate: 24000 });
    expect(l.byClass['realtime-connect']).toBe(1);
  });
});

describe('PERF-01 meter core', () => {
  it('reserves conservatively from the body alone', () => {
    const body = JSON.stringify({ model: 'gpt-6-luna', input: 'x'.repeat(3000), max_output_tokens: 360 });
    const r = core.reservationFor({ method: 'POST', path: '/v1/responses', body });
    expect(r).toMatchObject({ cls: 'responses', model: 'gpt-6-luna', completionTokens: 360, unbounded: false });
    expect(r.promptTokens).toBe(Math.ceil(Buffer.byteLength(body) / 3));
    expect(core.audioSeconds(Buffer.alloc(24000).toString('base64'))).toBeCloseTo(0.5, 5);
  });
});

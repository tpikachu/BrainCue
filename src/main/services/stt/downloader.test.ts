import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SttDownloadProgress } from '@shared/ipc';
import type { LocalSttModel } from '@shared/stt';
import { contentRangeTotal, downloadModel } from './downloader';

/**
 * A tiny origin that serves in-memory files with Range support, records the
 * request headers it saw, and can be told to trickle a response so a cancel
 * can land mid-stream, or to lie about a file's size.
 */
interface Fixture {
  files: Record<string, Buffer>;
  requests: { url: string; range: string | null }[];
  /** Per-path: hold the response open after the first chunk until released. */
  trickle: Record<string, { release: () => void; released: Promise<void> } | undefined>;
  /** Per-path: fail the connection this many times (destroy mid-body). */
  failTimes: Record<string, number>;
  /** Redirect `/r/<name>` → `/f/<name>` to mirror Hugging Face's resolve → CDN hop. */
  base: string;
  close: () => Promise<void>;
}

function startFixture(): Promise<Fixture> {
  const fx: Fixture = {
    files: {},
    requests: [],
    trickle: {},
    failTimes: {},
    base: '',
    close: async () => undefined,
  };
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/r/')) {
      res.writeHead(302, { Location: `${fx.base}/f/${url.slice(3)}` });
      res.end();
      return;
    }
    const name = url.replace(/^\/f\//, '');
    const body = fx.files[name];
    fx.requests.push({ url, range: req.headers.range ?? null });
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    let start = 0;
    const range = req.headers.range?.match(/^bytes=(\d+)-$/);
    if (range) {
      start = Number(range[1]);
      if (start >= body.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Length': String(body.length - start),
        'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`,
      });
    } else {
      res.writeHead(200, { 'Content-Length': String(body.length) });
    }
    const slice = body.subarray(start);
    if ((fx.failTimes[name] ?? 0) > 0) {
      fx.failTimes[name]! -= 1;
      // Flush half the body, THEN close with FIN (not RST — on Windows a reset
      // discards the peer's unread receive buffer): the client sees a premature
      // close with real bytes on disk and resumes from them on retry.
      res.write(slice.subarray(0, Math.floor(slice.length / 2)), () => res.socket?.end());
      return;
    }
    const gate = fx.trickle[name];
    if (gate) {
      res.write(slice.subarray(0, Math.max(1, Math.floor(slice.length / 4))));
      await gate.released;
      res.end(slice.subarray(Math.max(1, Math.floor(slice.length / 4))));
      return;
    }
    res.end(slice);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      fx.base = `http://127.0.0.1:${port}`;
      fx.close = () =>
        new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r());
        });
      resolve(fx);
    });
  });
}

const gate = (): { release: () => void; released: Promise<void> } => {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  return { release, released };
};

const bytes = (n: number, seed = 1): Buffer => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * seed + 7) & 0xff;
  return b;
};

let fx: Fixture;
let dir: string;

const makeModel = (files: { name: string; bytes: number; viaRedirect?: boolean }[]): LocalSttModel => ({
  id: 'test-model',
  name: 'Test',
  vendor: 'NVIDIA',
  languages: 'en',
  description: '',
  chunkMs: 560,
  sampleRate: 16000,
  featureDim: 128,
  totalBytes: files.reduce((n, f) => n + f.bytes, 0),
  files: files.map((f) => ({
    name: f.name,
    bytes: f.bytes,
    url: `${fx.base}/${f.viaRedirect ? 'r' : 'f'}/${f.name}`,
  })),
});

const run = (model: LocalSttModel, controller = new AbortController()) => {
  const events: SttDownloadProgress[] = [];
  const done = downloadModel(model, {
    dir,
    signal: controller.signal,
    onProgress: (p) => events.push(p),
    throttleMs: 0,
    retryDelaysMs: [1, 1, 1],
  });
  return { events, done, controller };
};

beforeAll(async () => {
  fx = await startFixture();
});
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'braincue-stt-'));
  fx.files = {};
  fx.requests = [];
  fx.trickle = {};
  fx.failTimes = {};
});

describe('downloadModel', () => {
  it('downloads every file (following redirects), verifies sizes and renames .part → final', async () => {
    fx.files['encoder.bin'] = bytes(50_000, 3);
    fx.files['tokens.txt'] = Buffer.from('a\nb\nc\n');
    const model = makeModel([
      { name: 'encoder.bin', bytes: 50_000, viaRedirect: true },
      { name: 'tokens.txt', bytes: 6 },
    ]);
    const { events, done } = run(model);
    const final = await done;

    expect(final.state).toBe('done');
    expect(final.receivedBytes).toBe(model.totalBytes);
    expect(final.percent).toBe(100);
    expect(readFileSync(path.join(dir, 'encoder.bin')).equals(fx.files['encoder.bin'])).toBe(true);
    expect(readFileSync(path.join(dir, 'tokens.txt'), 'utf8')).toBe('a\nb\nc\n');
    expect(existsSync(path.join(dir, 'encoder.bin.part'))).toBe(false);
    expect(events.some((e) => e.state === 'verifying' && e.file === 'encoder.bin')).toBe(true);
    // received bytes never go backwards and never exceed the total
    for (let i = 1; i < events.length; i++) {
      expect(events[i].receivedBytes).toBeGreaterThanOrEqual(events[i - 1].receivedBytes);
      expect(events[i].receivedBytes).toBeLessThanOrEqual(model.totalBytes);
    }
    // the redirect hop was followed transparently (no Range on a fresh file)
    expect(fx.requests.find((r) => r.url === '/f/encoder.bin')?.range).toBeNull();
  });

  it('resumes a partial .part with a Range request and only fetches the missing tail', async () => {
    fx.files['encoder.bin'] = bytes(40_000, 5);
    const partial = fx.files['encoder.bin'].subarray(0, 15_000);
    writeFileSync(path.join(dir, 'encoder.bin.part'), partial);
    const model = makeModel([{ name: 'encoder.bin', bytes: 40_000 }]);

    const { events, done } = run(model);
    const final = await done;

    expect(final.state).toBe('done');
    expect(fx.requests).toHaveLength(1);
    expect(fx.requests[0].range).toBe('bytes=15000-');
    expect(readFileSync(path.join(dir, 'encoder.bin')).equals(fx.files['encoder.bin'])).toBe(true);
    // the very first downloading tick already counts the resumed bytes
    const first = events.find((e) => e.state === 'downloading');
    expect(first?.receivedBytes).toBeGreaterThanOrEqual(15_000);
  });

  it('restarts the file when the server answers a Range request with 200', async () => {
    fx.files['plain.bin'] = bytes(20_000, 9);
    writeFileSync(path.join(dir, 'plain.bin.part'), Buffer.from('garbage-that-should-vanish'));
    const model = makeModel([{ name: 'plain.bin', bytes: 20_000 }]);
    // Override: the fixture honours ranges, so use a fetch wrapper that strips the header.
    const events: SttDownloadProgress[] = [];
    const final = await downloadModel(model, {
      dir,
      signal: new AbortController().signal,
      onProgress: (p) => events.push(p),
      throttleMs: 0,
      fetchImpl: (input, init) => {
        const headers = { ...(init?.headers as Record<string, string>) };
        delete headers.Range;
        return fetch(input, { ...init, headers });
      },
    });
    expect(final.state).toBe('done');
    expect(readFileSync(path.join(dir, 'plain.bin')).equals(fx.files['plain.bin'])).toBe(true);
  });

  it('reports a size mismatch as a user-safe error and drops the bad .part', async () => {
    fx.files['encoder.bin'] = bytes(10_000);
    const model = makeModel([{ name: 'encoder.bin', bytes: 12_345 }]); // catalog disagrees with the server
    const { done } = run(model);
    const final = await done;

    expect(final.state).toBe('error');
    expect(final.error).toMatch(/expected size/i);
    expect(final.error).not.toMatch(/[\\/]/); // no paths in user-facing text
    expect(existsSync(path.join(dir, 'encoder.bin'))).toBe(false);
    expect(existsSync(path.join(dir, 'encoder.bin.part'))).toBe(false);
  });

  it('cancel mid-stream ends in `cancelled` and keeps the .part for a later resume', async () => {
    fx.files['big.bin'] = bytes(80_000, 11);
    fx.trickle['big.bin'] = gate();
    const model = makeModel([{ name: 'big.bin', bytes: 80_000 }]);
    const { events, done, controller } = run(model);

    // wait until some bytes landed, then cancel
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (events.some((e) => e.state === 'downloading' && e.receivedBytes > 0)) {
          clearInterval(iv);
          resolve();
        }
      }, 5);
    });
    controller.abort();
    const final = await done;
    fx.trickle['big.bin']!.release();

    expect(final.state).toBe('cancelled');
    expect(existsSync(path.join(dir, 'big.bin'))).toBe(false);
    const part = path.join(dir, 'big.bin.part');
    expect(existsSync(part)).toBe(true);
    const kept = statSync(part).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(80_000);

    // …and a fresh run picks up exactly where it stopped.
    fx.requests = [];
    const again = await run(model).done;
    expect(again.state).toBe('done');
    expect(fx.requests[0].range).toBe(`bytes=${kept}-`);
    expect(readFileSync(path.join(dir, 'big.bin')).equals(fx.files['big.bin'])).toBe(true);
  });

  it('retries a dropped connection and resumes from the bytes already written', async () => {
    fx.files['flaky.bin'] = bytes(30_000, 13);
    fx.failTimes['flaky.bin'] = 2;
    const model = makeModel([{ name: 'flaky.bin', bytes: 30_000 }]);
    const final = await run(model).done;

    expect(final.state).toBe('done');
    expect(fx.requests.length).toBe(3);
    expect(fx.requests[1].range).toMatch(/^bytes=\d+-$/);
    expect(readFileSync(path.join(dir, 'flaky.bin')).equals(fx.files['flaky.bin'])).toBe(true);
  });

  it('gives up after the retry budget with a generic message', async () => {
    fx.files['dead.bin'] = bytes(30_000);
    fx.failTimes['dead.bin'] = 10;
    const model = makeModel([{ name: 'dead.bin', bytes: 30_000 }]);
    const final = await run(model).done;

    expect(final.state).toBe('error');
    expect(fx.requests.length).toBe(4); // 1 + 3 retries
    expect(final.error).toMatch(/connection/i);
    expect(existsSync(path.join(dir, 'dead.bin.part'))).toBe(true); // still resumable
  });

  it('skips files already complete on disk and surfaces an HTTP status as an error', async () => {
    fx.files['tokens.txt'] = Buffer.from('xyz');
    writeFileSync(path.join(dir, 'tokens.txt'), 'xyz');
    const model = makeModel([
      { name: 'tokens.txt', bytes: 3 },
      { name: 'missing.bin', bytes: 10 },
    ]);
    const final = await run(model).done;
    expect(fx.requests.every((r) => r.url !== '/f/tokens.txt')).toBe(true);
    expect(final.state).toBe('error');
    expect(final.error).toMatch(/HTTP 404/);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('contentRangeTotal', () => {
  it('parses the total and tolerates the unknown marker', () => {
    expect(contentRangeTotal('bytes 100-999/1000')).toBe(1000);
    expect(contentRangeTotal('bytes 0-9/*')).toBeNull();
    expect(contentRangeTotal(null)).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

/**
 * LIVE detection + answer-latency evaluation against a real provider.
 *
 * Skipped unless BRAINCUE_LIVE_EVAL=1 — it spends tokens on the configured
 * key. Runs the REAL detector (rules + classifier prompt + zod validation +
 * timeout) and the REAL answer prompt builder; only the transport is a thin
 * fetch against the OpenAI Responses API, so no Electron/DB is needed.
 *
 *   BRAINCUE_LIVE_EVAL=1 npx vitest run src/main/services/engine/interview/eval/detection.live.test.ts
 *   env: OPENAI_API_KEY (or .env), EVAL_CLASSIFY_MODEL, EVAL_ANSWER_MODEL
 *
 * What it can and cannot establish: classifier accuracy and provider
 * latency on this machine's network, sequentially (no parallel skew). It
 * measures time to the FIRST STREAMED TOKEN, not first visible content —
 * that needs the running app (the overlay reports it; metrics/latency.ts).
 */

const LIVE = process.env.BRAINCUE_LIVE_EVAL === '1';
const key = (() => {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    return readFileSync('.env', 'utf8').match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
})();
const CLASSIFY_MODEL = process.env.EVAL_CLASSIFY_MODEL ?? 'gpt-6-luna';
const ANSWER_MODEL = process.env.EVAL_ANSWER_MODEL ?? 'gpt-6-luna';

const calls = vi.hoisted(() => ({ classifyMs: [] as number[] }));

async function responses(body: Record<string, unknown>, stream = false): Promise<Response> {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

vi.mock('../../../../providers/registry', () => ({
  providerFor: () => ({
    async json(req: { system: string; user: string; maxOutputTokens?: number; signal?: AbortSignal }) {
      const t0 = performance.now();
      const res = await responses({
        model: CLASSIFY_MODEL,
        input: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        text: { format: { type: 'json_object' } },
        reasoning: { effort: 'none' },
        max_output_tokens: Math.max(200, req.maxOutputTokens ?? 0),
      });
      const j = (await res.json()) as { output?: { content?: { text?: string }[] }[] };
      calls.classifyMs.push(performance.now() - t0);
      const text = j.output?.flatMap((o) => o.content ?? []).find((c) => c.text)?.text ?? '';
      return JSON.parse(text);
    },
    async *stream(req: { system: string; user: string; maxOutputTokens?: number }) {
      const res = await responses(
        {
          model: ANSWER_MODEL,
          input: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          reasoning: { effort: 'none' },
          max_output_tokens: req.maxOutputTokens ?? 400,
        },
        true,
      );
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const evt = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = evt.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
          if (!data) continue;
          const e = JSON.parse(data) as { type: string; delta?: string };
          if (e.type === 'response.output_text.delta' && e.delta) yield { type: 'delta', token: e.delta };
        }
      }
    },
  }),
}));

import { detectQuestion } from '../detector';
import { streamAnswer } from '../../../openai/answer';
import { percentile } from '../../metrics/latency';
import { DETECTION_SET, type LabeledUtterance } from './detectionSet';
import { DETECTION_HOLDOUT } from './detectionHoldout';

function score(rows: { predicted: boolean; actual: boolean }[]) {
  const tp = rows.filter((r) => r.predicted && r.actual).length;
  const fp = rows.filter((r) => r.predicted && !r.actual).length;
  const fn = rows.filter((r) => !r.predicted && r.actual).length;
  return { precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), tp, fp, fn };
}

async function run(set: LabeledUtterance[], label: string) {
  const rows: {
    u: LabeledUtterance;
    predicted: boolean;
    eventual: boolean;
    actual: boolean;
    ms: number;
    eventualMs: number;
    source: string;
  }[] = [];
  for (const u of set) {
    const t0 = performance.now();
    // Production timeout — a slow call falls back exactly as it would live.
    const d = await detectQuestion(u.text, { recent: u.context });
    const ms = performance.now() - t0;
    // The scheduler acts on a late model "yes" the fallback said no to.
    let eventual = d.act;
    let eventualMs = ms;
    if (!d.act && d.late) {
      const late = await d.late;
      if (late?.act) {
        eventual = true;
        eventualMs = performance.now() - t0;
      }
    }
    rows.push({ u, predicted: d.act, eventual, actual: u.answer, ms, eventualMs, source: d.source });
  }
  const s = score(rows);
  const ev = score(rows.map((r) => ({ predicted: r.eventual, actual: r.actual })));
  const lateRows = rows.filter((r) => r.eventual && !r.predicted);
  console.info(
    `[LIVE detection · ${label} · EVENTUAL incl. late verdicts] precision=${ev.precision.toFixed(3)} recall=${ev.recall.toFixed(3)} ` +
      `(tp ${ev.tp} fp ${ev.fp} fn ${ev.fn}) · late answers=${lateRows.length} ` +
      `late final→decision p50=${percentile(lateRows.map((r) => r.eventualMs), 50)?.toFixed(0)}ms ` +
      `p95=${percentile(lateRows.map((r) => r.eventualMs), 95)?.toFixed(0)}ms\n  ` +
      rows
        .filter((r) => r.eventual !== r.actual)
        .map((r) => `${r.actual ? 'FN' : 'FP'}: ${r.u.text}`)
        .join('\n  '),
  );
  const ms = rows.map((r) => r.ms);
  const modelRows = rows.filter((r) => r.source !== 'heuristic');
  console.info(
    `[LIVE detection · ${label}] model=${CLASSIFY_MODEL} n=${rows.length} precision=${s.precision.toFixed(3)} ` +
      `recall=${s.recall.toFixed(3)} (tp ${s.tp} fp ${s.fp} fn ${s.fn}) · to-model=${modelRows.length} ` +
      `fallbacks=${rows.filter((r) => r.source === 'fallback').length} · final→decision p50=${percentile(ms, 50)?.toFixed(0)}ms ` +
      `p95=${percentile(ms, 95)?.toFixed(0)}ms · model-decided p50=${percentile(modelRows.map((r) => r.ms), 50)?.toFixed(0)}ms ` +
      `p95=${percentile(modelRows.map((r) => r.ms), 95)?.toFixed(0)}ms\n  ` +
      rows
        .filter((r) => r.predicted !== r.actual)
        .map((r) => `${r.actual ? 'FN' : 'FP'} (${r.source}): ${r.u.text}`)
        .join('\n  '),
  );
  return { s, rows };
}

describe.skipIf(!LIVE || !key)('LIVE detection + answer latency', () => {
  it(
    'detection on the dev and held-out sets',
    async () => {
      console.info(`[LIVE] host: ${os.cpus()[0]?.model} · ${os.cpus().length} cores · ${Math.round(os.totalmem() / 2 ** 30)} GB · ${os.platform()} ${os.release()}`);
      const dev = await run(DETECTION_SET, 'DEV');
      const held = await run(DETECTION_HOLDOUT, 'HELD-OUT');
      const all = score([...dev.rows, ...held.rows]);
      const allEv = score([...dev.rows, ...held.rows].map((r) => ({ predicted: r.eventual, actual: r.actual })));
      console.info(
        `[LIVE detection · ALL] on-time precision=${all.precision.toFixed(3)} recall=${all.recall.toFixed(3)} · ` +
          `eventual precision=${allEv.precision.toFixed(3)} recall=${allEv.recall.toFixed(3)}`,
      );
      console.info(
        `[LIVE classifier round trip] n=${calls.classifyMs.length} p50=${percentile(calls.classifyMs, 50)?.toFixed(0)}ms p95=${percentile(calls.classifyMs, 95)?.toFixed(0)}ms`,
      );
      expect(dev.rows.length).toBeGreaterThan(0);
    },
    600_000,
  );

  it(
    'finalized question → first streamed token, with the production answer prompt',
    async () => {
      const qs = DETECTION_HOLDOUT.filter((u) => u.answer).slice(0, 16);
      const ttft: number[] = [];
      const profile = {
        id: 'p',
        name: 'Alex Rivera',
        targetRole: 'Senior Backend Engineer',
        targetCompany: 'Acme',
        language: 'en',
      } as never;
      const chunks = [
        { id: 'c1', sourceType: 'resume', content: 'Senior engineer at Northwind (2021–2025): rebuilt the search ranking pipeline; moved to learning-to-rank; +14% click-through.', score: 0.8 },
        { id: 'c2', sourceType: 'jd', content: 'Requirements: 5+ years backend, distributed systems, Go or Java, on-call experience.', score: 0.7 },
      ] as never;
      for (const [i, u] of qs.entries()) {
        const t0 = performance.now();
        // The detection a live session would run first, then the answer.
        await detectQuestion(u.text, { recent: u.context });
        for await (const ev of streamAnswer({ question: u.text, contextChunks: chunks, profile, format: 'general', pronunciation: false })) {
          if (ev.type === 'delta') {
            ttft.push(performance.now() - t0);
            break;
          }
        }
        if (i === 0) console.info(`[LIVE answer] cold first question: ${ttft[0]?.toFixed(0)}ms`);
      }
      const warm = ttft.slice(1);
      console.info(
        `[LIVE final→first token · ${ANSWER_MODEL}] n=${ttft.length} cold=${ttft[0]?.toFixed(0)}ms · warm n=${warm.length} ` +
          `p50=${percentile(warm, 50)?.toFixed(0)}ms p95=${percentile(warm, 95)?.toFixed(0)}ms (no retrieval: grounding passed in)`,
      );
      expect(ttft.length).toBe(qs.length);
    },
    600_000,
  );
});

import { LatencyRecorder, type QuestionTiming } from './latency';

/**
 * The process-wide latency recorder. Completed question timings (no text)
 * are also handed to a sink that main installs at startup — a JSON-lines
 * file in the user-data folder (`metrics/latency.jsonl`), so a live
 * verification run leaves evidence behind. Tests run without a sink.
 */
let sink: ((t: QuestionTiming) => void) | null = null;

export function setLatencySink(fn: ((t: QuestionTiming) => void) | null): void {
  sink = fn;
}

export const latency = new LatencyRecorder(500, (t) => sink?.(t));

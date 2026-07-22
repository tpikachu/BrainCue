/**
 * Normalized engine inputs. Every source feeds the engine through one of
 * these; the mode's trigger policy decides what (if anything) to do.
 *
 * `transcript_delta`, `screen_capture`, and `clipboard_text` are declared for
 * the full v2 shape but not yet routed through the engine: interim deltas
 * stream straight to the overlay (no decision to make), and the screen/
 * clipboard paths stay in services/capture until the contribution-cards PR
 * folds them in.
 */
export type ContextEvent =
  | { kind: 'transcript_final'; sessionId: string; text: string }
  | { kind: 'transcript_delta'; sessionId: string; text: string }
  | { kind: 'direct_ask'; sessionId: string; text: string }
  | { kind: 'screen_capture'; sessionId: string; imageDataUrl: string }
  | { kind: 'clipboard_text'; sessionId: string; text: string }
  | { kind: 'session_control'; sessionId: string; action: 'pause' | 'resume' | 'stop' };

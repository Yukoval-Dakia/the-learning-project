// YUK-1909 — wire names for the display-only thinking lane, shared by the SSE
// producer and the UI seam. Zero dependencies: this file must stay importable
// from both sides without pulling server code into the browser bundle.

/**
 * Live-only frame type. The frame is emitted as `data:` with no `id:` (so
 * EventSource-style reconnects never replay it) and carries:
 * `{ task_run_id, seq, text }` — seq is strictly increasing per task_run_id.
 */
export const COPILOT_RUN_THINKING_EVENT = 'copilot_run.thinking' as const;

/**
 * Durable step result for one attempt's thinking lane. `streamed` means at
 * least one live delta was produced; `none` means the provider returned no
 * reasoning; `suppressed` means this turn deliberately does not expose
 * reasoning text (fixed or answer-bound replies) even if the model thought.
 */
export type CopilotThinkingEndResult = 'streamed' | 'none' | 'suppressed';

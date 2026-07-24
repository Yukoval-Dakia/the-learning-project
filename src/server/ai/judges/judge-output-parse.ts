// YUK-230 (PR #1063 review, thread 7) — shared judge output-parse helpers.
//
// extractJsonObject was copy-pasted into steps-judge, multimodal-direct-judge,
// question-contract (semantic) and source-grounding-verify (4 copies); the structured
// runTask default was copy-pasted into the 3 vision judges. Both are consolidated here.
// Each caller keeps its OWN error label so the thrown message is byte-identical to the
// pre-consolidation text (the golden replay + evidence_json.error contracts depend on it).

import type { RunTaskCtx } from '@/server/ai/runner';

/** The structured task result the vision judges consume from runTask. */
export interface StructuredTaskResult {
  text: string;
  structured_output?: unknown;
}

/**
 * Default production runner for the structured-output vision judges: forward to runTask,
 * keeping the SDK `structured_output` passthrough. Injectable seams (tests) replace this.
 */
export async function defaultStructuredRunTaskFn(
  kind: string,
  input: unknown,
  ctx: RunTaskCtx,
): Promise<StructuredTaskResult> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx);
  return { text: result.text, structured_output: result.structured_output };
}

/**
 * Char-scan the first `{...}` JSON object out of a text blob. `label` names the caller so
 * the thrown message stays byte-identical to each judge's pre-consolidation text (e.g.
 * `steps judge output did not contain a JSON object`).
 */
export function extractJsonObject(text: string, label: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${label} did not contain a JSON object`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

// Prior-context projection for a recovering preparer segment. A recovery must know what the
// dead segment already did without replaying learner material into the next model call:
// tool inputs may hold learner words (the model can write them into any argument) and
// learner-evidence tools return the learner's mistakes/notes/mastery. So this is a
// default-deny whitelist — a newly added tool contributes nothing until someone names it.
// The two external fetch tools are the one content exception: their candidate payload is
// the paid fetch result, and dropping it would force a re-fetch after a crash.
import type { preparerTerminal } from './question-preparer-contract';

/** Tools whose output is a paid external fetch that must not be repeated. */
const PAID_FETCH_TOOLS = new Set(['web_fetch_candidates', 'jyeoo_fetch_candidates']);

/** Structured facts, never free text (status codes and booleans only). */
const FACT_KEYS = new Set([
  'status',
  'publish_status',
  'published',
  'replayed',
  'verify_enqueued',
  'failure_class',
  'retryable',
  'revision_ordinal',
  'code',
]);

/** Id-like keys only; their values are ids/versions, not prose. */
const ID_KEY = /(^|_)(id|ids|ref|version)$/;

type FactRecord = Record<string, unknown>;

function projectFacts(value: unknown, depth = 0): FactRecord | unknown[] | undefined {
  if (depth > 4 || value == null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => projectFacts(entry, depth + 1))
      .filter((entry) => entry !== undefined);
    return entries.length > 0 ? entries : undefined;
  }
  const out: FactRecord = {};
  for (const [key, entry] of Object.entries(value as FactRecord)) {
    if (entry == null) continue;
    if (
      FACT_KEYS.has(key) &&
      (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number')
    ) {
      out[key] = entry;
    } else if (ID_KEY.test(key)) {
      if (typeof entry === 'string' || typeof entry === 'number') out[key] = entry;
      else if (
        Array.isArray(entry) &&
        entry.every((item) => typeof item === 'string' || typeof item === 'number')
      )
        out[key] = entry;
    } else if (typeof entry === 'object') {
      const nested = projectFacts(entry, depth + 1);
      if (
        nested !== undefined &&
        (Array.isArray(nested) ? nested.length > 0 : Object.keys(nested).length > 0)
      )
        out[key] = nested;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface RecoveryCallRow {
  tool_name: string;
  input_json: unknown;
  output_json: unknown;
  error_reason: string | null;
}

function recoveryCallFacts(call: RecoveryCallRow): FactRecord {
  const facts: FactRecord = {
    tool: call.tool_name,
    status: call.error_reason != null ? 'error' : 'ok',
  };
  if (call.error_reason != null) facts.error = call.error_reason;
  if (PAID_FETCH_TOOLS.has(call.tool_name)) {
    // Keep the fetched candidates (the paid result) and the fixed status/failure facts.
    const output = call.output_json as FactRecord | null;
    if (output != null && typeof output === 'object') {
      if ('candidates' in output) facts.candidates = output.candidates;
      const fixed = projectFacts(output);
      if (fixed !== undefined) facts.output = fixed;
    }
    return facts;
  }
  const factsOnly = projectFacts(call.output_json);
  if (factsOnly !== undefined) facts.output = factsOnly;
  return facts;
}

/** Called only for a recovery/continuation segment; `previous` carries no summary text. */
export function recoveryPriorContext(
  previous: ReturnType<typeof preparerTerminal.parse>,
  calls: readonly RecoveryCallRow[],
): FactRecord {
  return {
    previous: {
      outcome: previous.outcome,
      retryable: previous.retryable ?? false,
      task_run_id: previous.task_run_id,
    },
    calls: calls.map((call) => recoveryCallFacts(call)),
  };
}

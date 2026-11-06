// Prior-context projection for a recovering preparer segment. A recovery must know what the
// dead segment already did without replaying learner material into the next model call:
// tool inputs may hold learner words (the model can write them into any argument), and
// learner-evidence tools return the learner's mistakes/notes/mastery. So this is a
// default-deny whitelist of fact keys — a newly added tool contributes only id-like/status
// facts, never its inputs or free text.
//
// The two external fetch tools keep their candidate payloads: that is the paid fetch result
// and `submit_question` needs the full candidate, so dropping it would force a re-fetch.
// Those candidates are model-authored output whose content this module does not verify, and
// the gap ticket's free text is sent separately; the guarantee here is only that recovery
// stops carrying learner text from the tool-call history.
import type { preparerTerminal } from './question-preparer-contract';

/** Tools whose output is a paid external fetch that must not be repeated. */
const PAID_FETCH_TOOLS = new Set(['web_fetch_candidates', 'jyeoo_fetch_candidates']);

/** Fixed status/category codes only; free text never passes. */
const CODE_KEYS = new Set(['status', 'publish_status', 'code', 'failure_class']);
const FLAG_KEYS = new Set(['published', 'replayed', 'verify_enqueued', 'retryable']);
const NUMBER_KEYS = new Set(['revision_ordinal']);

/** Id-like keys only; their values must also look like ids (see ID_VALUE). */
const ID_KEY = /(^|_)(id|ids|ref|version)$/;

/** Server error codes worth keeping; every other message becomes `tool_error` so the raw
 *  message (which can echo argument values) never enters the model context. */
const ERROR_CODES = new Set(['tool_args_contract_failed']);

/** cuid2 ids, `qdraft1:<block>:<version>` refs, uuids and lowercase slugs. No uppercase,
 *  no whitespace: a model-written sentence does not pass. */
const ID_VALUE = /^[a-z0-9][a-z0-9._:@-]{0,127}$/;
const CODE_VALUE = /^[a-z][a-z0-9_]{0,63}$/;

type FactRecord = Record<string, unknown>;

function projectValue(key: string, entry: unknown, depth: number): unknown {
  if (entry == null) return undefined;
  if (CODE_KEYS.has(key))
    return typeof entry === 'string' && CODE_VALUE.test(entry) ? entry : undefined;
  if (FLAG_KEYS.has(key)) return typeof entry === 'boolean' ? entry : undefined;
  if (NUMBER_KEYS.has(key)) return typeof entry === 'number' ? entry : undefined;
  if (ID_KEY.test(key)) {
    if (typeof entry === 'number') return entry;
    if (typeof entry === 'string') return ID_VALUE.test(entry) ? entry : undefined;
    if (Array.isArray(entry)) {
      const values = entry.filter(
        (item): item is string => typeof item === 'string' && ID_VALUE.test(item),
      );
      return values.length > 0 ? values : undefined;
    }
    return undefined;
  }
  if (typeof entry === 'object') {
    const nested = projectFacts(entry, depth + 1);
    return nested !== undefined &&
      (Array.isArray(nested) ? nested.length > 0 : Object.keys(nested).length > 0)
      ? nested
      : undefined;
  }
  return undefined;
}

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
    const projected = projectValue(key, entry, depth);
    if (projected !== undefined) out[key] = projected;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface RecoveryCallRow {
  tool_name: string;
  input_json: unknown;
  output_json: unknown;
  error_reason: string | null;
}

function errorCategory(reason: string): string {
  return ERROR_CODES.has(reason) ? reason : 'tool_error';
}

function recoveryCallFacts(call: RecoveryCallRow): FactRecord {
  const facts: FactRecord = {
    tool: call.tool_name,
    status: call.error_reason != null ? 'error' : 'ok',
  };
  if (call.error_reason != null) facts.error = errorCategory(call.error_reason);
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

// YUK-1547 — single source for the structured-submit wire policy shared by
// the pi adapter (pi-agent-adapter.ts) and the admission ops scripts
// (preflight / backlog driver). The catalog has no bit for "endpoint accepts a
// forced named tool_choice on this resolved wire shape", so the capability is
// binding-declared (PROVIDER_MODEL_BINDINGS → resolveModelProfile) and this
// module is where the resolved capability becomes a wire decision.
//
// Policy: a lane may force `tool_choice:{type:'function'}` for the submit tool
// only while its profile does NOT record forcedToolChoice:false. A recorded
// rejection (e.g. opencode-go/deepseek-v4.1-flash thinking mode, request_id
// 6fde3ba6-8f64-4c84-8a3d-5a5e211b430a) degrades the lane to
// tool_choice:'auto' — the prompt contract and exactly one closing reminder
// carry the submit obligation instead. 'unknown' keeps the legacy forced
// posture: forcing is the proven fix for the text-JSON drift these tasks were
// admitted under, and absent evidence of breakage the runner must not silently
// weaken every lane's wire guarantee.

import type { Provider } from '@/capabilities/task-registry';
import { type ModelCapabilityTriState, resolveModelProfile } from './model-profiles';

/** Wire name of the mounted structured-output submit tool (`structured_output`/`submit`). */
export const STRUCTURED_OUTPUT_SUBMIT_TOOL = 'mcp__structured_output__submit';

export interface StructuredSubmitPolicy {
  /** true → the request forces the named submit call; false → tool_choice 'auto'. */
  readonly forced: boolean;
  /** The profile capability value that produced the decision (receipt evidence). */
  readonly capability: ModelCapabilityTriState;
}

export function resolveStructuredSubmitPolicy(
  provider: Provider,
  model: string,
): StructuredSubmitPolicy {
  const capability = resolveModelProfile(provider, model).capabilities.forcedToolChoice;
  return { forced: capability !== false, capability };
}

/** The `tool_choice`/`parallel_tool_calls` fields merged into the request body verbatim. */
export function structuredSubmitWireFields(policy: StructuredSubmitPolicy):
  | {
      tool_choice: { type: 'function'; function: { name: string } };
      parallel_tool_calls: false;
    }
  | { tool_choice: 'auto'; parallel_tool_calls: false } {
  return policy.forced
    ? {
        tool_choice: {
          type: 'function',
          function: { name: STRUCTURED_OUTPUT_SUBMIT_TOOL },
        },
        parallel_tool_calls: false,
      }
    : { tool_choice: 'auto', parallel_tool_calls: false };
}

/**
 * System-prompt suffix the adapter appends for structuredOutputMode:'tool'
 * tasks. The forced variant ends after one model turn (unchanged contract);
 * the auto variant may take exactly one reminder turn when the first ends
 * without the submit call.
 */
export function structuredSubmitSystemSuffix(forced: boolean): string {
  return forced
    ? `\nSubmit exactly one ${STRUCTURED_OUTPUT_SUBMIT_TOOL} tool call whose arguments are the requested output object itself (no result envelope). Do not return JSON as text. This invocation ends after this one model turn, including on invalid arguments; no repair turn is available.`
    : `\nSubmit exactly one ${STRUCTURED_OUTPUT_SUBMIT_TOOL} tool call whose arguments are the requested output object itself (no result envelope). Do not return JSON as text. If a turn ends without the submit call you get exactly one reminder turn; there is no schema-repair turn.`;
}

/**
 * The one closing reminder (C2-landing shape, ADR-0075 §D2): injected once via
 * the pi follow-up surface when a structured-output turn would otherwise stop
 * without the submit call. Deliberately generic — no mode- or task-specific
 * content, so A/B/crosscheck and every structured submit share one policy.
 */
export const STRUCTURED_SUBMIT_REMINDER =
  `You finished without the required tool call. Call ${STRUCTURED_OUTPUT_SUBMIT_TOOL} ` +
  'exactly once now with the complete output object as its arguments (no result envelope). ' +
  'This is the only reminder; the run ends after this turn.';

// ─── bounded submit turn machine ─────────────────────────────────────────────
//
// YUK-1547 — ONE shared classification for "did this model turn produce the
// submit call", consumed by the pi adapter (finishTurn) and the ops preflight
// (its second, authorized landing request). Any turn carrying tool calls that
// is not exactly the one landed submit — wrong tool, multiple calls, truncated
// arguments — is terminal_failure IMMEDIATELY: pi continues the inner loop on
// truncated calls (failToolCallsFromTruncatedMessage returns
// terminate=false), so anything else would silently pay for repair turns.
// A clean text-only end is the only turn allowed exactly one reminder.
//
// Turn bound: initial turn + at most one reminder turn. Never more.

export type SubmitTurnVerdict = 'landed' | 'needs_reminder' | 'terminal_failure';

export interface SubmitTurnSignal {
  /** pi AssistantMessage.stopReason ('stop'|'toolUse'|'length'|'error'|…)
   *  or a non-stream OpenAI choice finish_reason ('stop'|'tool_calls'|'length'|…). */
  stopReason: string | undefined;
  /** Names of toolCall blocks / tool_calls in the turn's message. */
  toolCallNames: string[];
}

export function classifySubmitTurn(
  signal: SubmitTurnSignal,
  opts: { forced: boolean },
): SubmitTurnVerdict {
  const calls = signal.toolCallNames;
  const landed =
    (signal.stopReason === 'toolUse' || signal.stopReason === 'tool_calls') &&
    calls.length === 1 &&
    calls[0] === STRUCTURED_OUTPUT_SUBMIT_TOOL;
  if (landed) return 'landed';
  // Any tool call that is not the clean single submit — wrong tool, extra
  // calls, truncated 'length' payloads — ends the run with evidence; the pi
  // inner loop would otherwise continue paying for repair turns.
  if (calls.length > 0) return 'terminal_failure';
  // A clean text-only end is the only landing-eligible turn, and only on
  // 'auto' lanes — a forced lane's text turn is a provider contract violation.
  if (signal.stopReason === 'stop' || signal.stopReason === 'end_turn') {
    return opts.forced ? 'terminal_failure' : 'needs_reminder';
  }
  return 'terminal_failure';
}

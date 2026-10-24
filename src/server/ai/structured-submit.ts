// YUK-1547 — single source for the structured-submit wire policy, shared by the pi
// adapter and the admission ops scripts. The catalog has no bit for "endpoint
// accepts a forced named tool_choice", so the capability is binding-declared and
// this module turns it into a wire decision.
//
// A lane may force `tool_choice:{type:'function'}` while its profile does NOT record
// forcedToolChoice:false. A recorded rejection (e.g. opencode-go deepseek thinking
// mode) degrades to 'auto' with the prompt contract and one closing reminder.
// 'unknown' keeps the legacy forced posture: forcing is the proven fix for the
// text-JSON drift these tasks were admitted under, and absent evidence of breakage
// the runner must not weaken every lane's wire guarantee.

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
 * System-prompt suffix for structuredOutputMode:'tool' tasks. Both variants share
 * ONE landing budget: the extra turn is either the missing-submit reminder or a
 * single parameter-contract correction.
 */
export function structuredSubmitSystemSuffix(forced: boolean): string {
  return forced
    ? `\nSubmit exactly one ${STRUCTURED_OUTPUT_SUBMIT_TOOL} tool call whose arguments are the requested output object itself (no result envelope). Do not return JSON as text. This invocation ends after this one model turn; the only extra turn is a single correction if the submit is rejected for malformed argument types (array/object fields must be actual JSON values, not quoted strings).`
    : `\nSubmit exactly one ${STRUCTURED_OUTPUT_SUBMIT_TOOL} tool call whose arguments are the requested output object itself (no result envelope). Do not return JSON as text. If a turn ends without the submit call, or the submit is rejected for malformed argument types (array/object fields must be actual JSON values, not quoted strings), you get exactly one correction turn total; the run then ends.`;
}

/**
 * The one closing reminder (C2-landing shape, ADR-0075 §D2), injected once via the
 * pi follow-up surface. Deliberately generic so every structured submit shares it.
 */
export const STRUCTURED_SUBMIT_REMINDER =
  `You finished without the required tool call. Call ${STRUCTURED_OUTPUT_SUBMIT_TOOL} ` +
  'exactly once now with the complete output object as its arguments (no result envelope). ' +
  'This is the only reminder; the run ends after this turn.';

// ─── bounded submit turn machine ─────────────────────────────────────────────
//
// ONE shared classification for "did this turn produce the submit call", consumed
// by the pi adapter and the ops preflight. Any turn with tool calls that is not
// exactly the one landed submit is terminal_failure immediately: pi continues the
// inner loop on truncated calls, so anything else silently pays for repair turns.
// A clean text-only end is the only turn allowed exactly one reminder; the bound
// is initial turn + at most one reminder turn.

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
  // Any tool call that is not the clean single submit ends the run with evidence;
  // the pi inner loop would otherwise continue paying for repair turns.
  if (calls.length > 0) return 'terminal_failure';
  // A clean text-only end is landing-eligible only on 'auto' lanes — a forced
  // lane's text turn is a provider contract violation.
  if (signal.stopReason === 'stop' || signal.stopReason === 'end_turn') {
    return opts.forced ? 'terminal_failure' : 'needs_reminder';
  }
  return 'terminal_failure';
}

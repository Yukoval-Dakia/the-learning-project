// YUK-1547 — single source for the structured-submit wire policy, shared by the pi
// adapter and the admission ops scripts. The catalog has no bit for "endpoint
// accepts a forced named tool_choice", so the capability is binding-declared and
// this module turns it into a wire decision.
//
// A lane may force `tool_choice:{type:'function'}` while its profile does NOT record
// forcedToolChoice:false. A recorded rejection (e.g. opencode-go deepseek thinking
// mode) degrades to 'auto' with the same submission correction contract.
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
export function structuredSubmitWireFields(
  policy: StructuredSubmitPolicy,
  api: 'openai-completions' | 'openai-responses' = 'openai-completions',
):
  | {
      tool_choice:
        | { type: 'function'; function: { name: string } }
        | { type: 'function'; name: string };
      parallel_tool_calls: false;
    }
  | { tool_choice: 'auto'; parallel_tool_calls: false } {
  return policy.forced
    ? {
        tool_choice:
          api === 'openai-responses'
            ? { type: 'function', name: STRUCTURED_OUTPUT_SUBMIT_TOOL }
            : {
                type: 'function',
                function: { name: STRUCTURED_OUTPUT_SUBMIT_TOOL },
              },
        parallel_tool_calls: false,
      }
    : { tool_choice: 'auto', parallel_tool_calls: false };
}

/** The tool result is the correction; successful validation completes immediately. */
export function structuredSubmitSystemSuffix(_forced: boolean): string {
  return `\nSubmit through ${STRUCTURED_OUTPUT_SUBMIT_TOOL} with the complete output object as arguments (no result envelope). Do not return JSON as text. If rejected, correct the reported field/shape errors and submit again. Arrays and objects must be actual JSON values, not quoted strings. Completion requires an accepted submit; repetition without progress, time and financial budgets end an unsuccessful run.`;
}

export const STRUCTURED_SUBMIT_REMINDER =
  `You finished without the required tool call. Call ${STRUCTURED_OUTPUT_SUBMIT_TOOL} ` +
  'with the complete output object as arguments (no result envelope).';

export type SubmitTurnVerdict = 'landed' | 'needs_reminder' | 'terminal_failure';
export interface SubmitTurnSignal {
  stopReason: string | undefined;
  toolCallNames: string[];
}

export function classifySubmitTurn(
  signal: SubmitTurnSignal,
  _opts: { forced: boolean },
): SubmitTurnVerdict {
  if (signal.stopReason === 'error' || signal.stopReason === 'aborted') return 'terminal_failure';
  return (signal.stopReason === 'toolUse' || signal.stopReason === 'tool_calls') &&
    signal.toolCallNames.length === 1 &&
    signal.toolCallNames[0] === STRUCTURED_OUTPUT_SUBMIT_TOOL
    ? 'landed'
    : 'needs_reminder';
}

/** Only schema-declared field names and issue codes cross back into model context.
 * Unknown property names, received values, messages and enum/literal values never do. */
export function structuredSubmitShapeErrors(
  parameters: unknown,
  issues: readonly unknown[],
): string[] {
  const fields = new Set<string>();
  const collect = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.properties && typeof obj.properties === 'object')
      Object.keys(obj.properties).forEach((name) => {
        fields.add(name);
      });
    Object.values(obj).forEach(collect);
  };
  collect(parameters);
  const errors = new Set<string>();
  const visit = (issue: unknown): void => {
    if (!issue || typeof issue !== 'object') return;
    const item = issue as {
      code?: string;
      path?: unknown[];
      expected?: unknown;
      errors?: unknown[][];
    };
    if (item.code === 'invalid_union' && item.errors) {
      item.errors.flat().forEach(visit);
      return;
    }
    const path = (item.path ?? [])
      .map((part) =>
        typeof part === 'number'
          ? '[]'
          : typeof part === 'string' && fields.has(part)
            ? part
            : '[field]',
      )
      .join('.');
    const codes = new Set([
      'invalid_type',
      'invalid_value',
      'unrecognized_keys',
      'too_small',
      'too_big',
      'invalid_format',
    ]);
    const code = item.code && codes.has(item.code) ? item.code : 'invalid_shape';
    const expected =
      typeof item.expected === 'string' &&
      ['array', 'object', 'string', 'number', 'boolean'].includes(item.expected)
        ? `; expected ${item.expected}`
        : '';
    errors.add(`${path || '(root)'}: ${code}${expected}`);
  };
  issues.forEach(visit);
  return [...errors].sort();
}

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

import { createHash } from 'node:crypto';
import type { AgentTurnContext } from '@earendil-works/pi-agent-core';
import type { ZodTypeAny } from 'zod';
import { createNoProgressLoop } from '@/ai/no-progress-loop';
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

/** Only schema field names, types and JSON offsets cross back into model context.
 * Unknown names, field values, exception messages and enum/literal values never do. */
export function structuredSubmitShapeErrors(
  parameters: unknown,
  issues: readonly unknown[],
  candidate?: unknown,
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
      keys?: unknown[];
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
    let detail = '';
    if (candidate !== undefined) {
      const value = (item.path ?? []).reduce<unknown>((node, part) => {
        if (!node || typeof node !== 'object') return undefined;
        return Object.getOwnPropertyDescriptor(node, String(part))?.value;
      }, candidate);
      if (code === 'invalid_type') {
        detail = `; you supplied ${jsonType(value)}`;
        if (item.expected === 'array') detail += '; use an actual JSON array, not a quoted string';
        if (typeof value === 'string' && ['array', 'object'].includes(String(item.expected)))
          detail += jsonSyntaxLocation(value);
      } else if (code === 'unrecognized_keys') {
        const extra = (item.keys ?? []).map((key) =>
          typeof key === 'string' && fields.has(key) ? key : '[field]',
        );
        detail = `; remove fields not declared at this object level: ${[...new Set(extra)].sort().join(', ')}`;
      }
    }
    errors.add(`${path || '(root)'}: ${code}${expected}${detail}`);
  };
  issues.forEach(visit);
  return [...errors].sort();
}

function jsonType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function jsonSyntaxLocation(raw: string): string {
  try {
    JSON.parse(raw);
    return '';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const offset = /\bposition (\d+)\b/.exec(message)?.[1];
    const position =
      offset === undefined
        ? /end of JSON/i.test(message)
          ? raw.length
          : undefined
        : Number(offset);
    // Never forward the native parser message: it can contain answer fragments.
    return position === undefined ? '' : `; JSON is invalid at character ${position + 1}`;
  }
}

function canonicalOutput(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOutput).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalOutput(object[key])}`)
    .join(',')}}`;
}

function outputHash(rawArguments: readonly (string | undefined)[], fallback: unknown): string {
  const output = rawArguments.length
    ? rawArguments.map((raw) => {
        if (raw === undefined) return { missing: true, output: fallback };
        try {
          return { json: JSON.parse(raw) as unknown };
        } catch {
          return { raw };
        }
      })
    : fallback;
  return createHash('sha256').update(canonicalOutput(output)).digest('hex');
}

/** Owns submission acceptance, safe correction context and no-progress closure for one run. */
export function createStructuredSubmitLoop(input: {
  schema: ZodTypeAny | undefined;
  parameters: unknown;
  taskInput: unknown;
  validate?: (output: unknown, taskInput: unknown) => readonly string[];
  forced: boolean;
  runId: string;
  correctionDeadline: number;
}) {
  const submitProgress = createNoProgressLoop();
  const errorOccurrences = new Map<string, number>();
  let submitAccepted = false;
  let submitFailure: string | undefined;
  let submitFeedback: string | undefined;
  return {
    get accepted() {
      return submitAccepted;
    },
    get failure() {
      return submitFailure;
    },
    takeFeedback() {
      const feedback = submitFeedback;
      submitFeedback = undefined;
      return feedback;
    },
    async finishTurn(
      { message, toolResults }: Pick<AgentTurnContext, 'message' | 'toolResults'>,
      invalidStructuredArguments: boolean,
      repairedArguments: unknown,
      rawArguments: readonly (string | undefined)[],
    ) {
      const calls = message.content.filter((block) => block.type === 'toolCall');
      const verdict = classifySubmitTurn(
        { stopReason: message.stopReason, toolCallNames: calls.map((call) => call.name) },
        { forced: input.forced },
      );
      const schema = input.schema;
      if (!schema) throw new Error('Structured submit schema unavailable');
      const candidate = repairedArguments ?? calls[0]?.arguments;
      const parsed = schema.safeParse(candidate);

      const errors = invalidStructuredArguments
        ? [
            `Arguments must be one complete strictly valid JSON object${rawArguments
              .filter((raw): raw is string => raw !== undefined)
              .map(jsonSyntaxLocation)
              .join('')}; resubmit without truncation or trailing commas.`,
          ]
        : verdict !== 'landed'
          ? [STRUCTURED_SUBMIT_REMINDER]
          : !parsed.success
            ? structuredSubmitShapeErrors(input.parameters, parsed.error.issues, candidate)
            : [...(input.validate?.(parsed.data, input.taskInput) ?? [])];
      if (errors.length === 0 && toolResults.length === 1 && !toolResults[0]?.isError) {
        submitAccepted = true;
        return { action: 'end' as const };
      }
      // Replace native pi/Ajv diagnostics, which may echo received values.
      const feedback = errors.length
        ? errors.sort().join('\n')
        : 'Submit arguments failed shape validation; use the declared fields and types.';
      for (const result of toolResults) {
        result.isError = true;
        result.content = [{ type: 'text', text: feedback }];
      }
      const errorKey =
        !invalidStructuredArguments && verdict === 'landed' && !parsed.success
          ? structuredSubmitShapeErrors(input.parameters, parsed.error.issues).join('\n')
          : feedback.replace(/character \d+/g, 'character [position]');
      const hash = outputHash(
        rawArguments,
        calls.length
          ? calls.map((call) => call.arguments)
          : message.content.filter((block) => block.type === 'text').map((block) => block.text),
      );
      const occurrences = (errorOccurrences.get(errorKey) ?? 0) + 1;
      errorOccurrences.set(errorKey, occurrences);
      const observation = JSON.stringify({
        status: 'invalid',
        error: errorKey,
        issues: { output_hash: hash },
      });
      await submitProgress.afterToolCall({
        call: { id: `submit-${message.timestamp}`, name: STRUCTURED_OUTPUT_SUBMIT_TOOL },
        args: {},
        effect: 'read',
        isError: true,
        output: observation,
        error: observation,
      });
      submitFailure =
        submitProgress.closure()?.reason ?? (occurrences >= 3 ? 'no_progress' : undefined);
      if (!submitFailure && Date.now() >= input.correctionDeadline)
        submitFailure = 'budget_landing';
      console.info(
        '[structured_submit_validation]',
        JSON.stringify({
          task_run_id: input.runId,
          output_hash: hash,
          error_occurrences: occurrences,
          closure: submitFailure ?? null,
          diagnostics: feedback,
        }),
      );
      if (submitFailure) return { action: 'end' as const };
      console.info(
        '[structured_submit_correction]',
        JSON.stringify({ task_run_id: input.runId, diagnostics: feedback }),
      );
      submitFeedback = feedback;
      return { action: 'continue' as const };
    },
  };
}

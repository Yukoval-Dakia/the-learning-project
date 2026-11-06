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
import type { StructuredSubmitUnitPlan } from '@/ai/task-spec';
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

/** YUK-1904 — unit-mode contract: one unit per submit call, accepted units are not rewritten. */
export function structuredSubmitUnitSuffix(_forced: boolean): string {
  return `\nSubmit ONE unit per ${STRUCTURED_OUTPUT_SUBMIT_TOOL} call: the call's arguments are a single unit object, never the whole array and never a JSON-encoded string. A rejected unit is corrected from the reported field/shape errors and resubmitted on its own; a unit whose acceptance receipt you already received must not be resubmitted. Completion requires every input unit accepted; repetition without progress, time and financial budgets end an unsuccessful run.`;
}

export const STRUCTURED_SUBMIT_UNIT_REMINDER =
  `You finished without the required tool call. Call ${STRUCTURED_OUTPUT_SUBMIT_TOOL} ` +
  'with ONE not-yet-accepted unit object as arguments (no result envelope).';

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
    if (item.code === 'invalid_union' && item.errors && item.errors.length > 0) {
      item.errors.flat().forEach(visit);
      return;
    }
    // A discriminated-union miss arrives as invalid_union with an EMPTY errors
    // array; falling through reports the discriminator path (a declared field)
    // as a shape error instead of silently returning no feedback.
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

type SealedUnit = { readonly error: string; readonly occurrences: number };

function oneLine(text: string, cap = 200): string {
  const flat = text.replaceAll('\n', ' | ');
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/** Owns submission acceptance, safe correction context and no-progress closure for one run. */
export function createStructuredSubmitLoop(input: {
  schema: ZodTypeAny | undefined;
  parameters: unknown;
  taskInput: unknown;
  /** YUK-1904 — unit mode: per-unit accept/seal/assemble; absent = whole-output submit. */
  units?: StructuredSubmitUnitPlan;
  /** Final guard: the assembled unit output must parse against the full output schema. */
  fullSchema?: ZodTypeAny;
  forced: boolean;
  runId: string;
  correctionDeadline: number;
}) {
  const submitProgress = createNoProgressLoop();
  const errorOccurrences = new Map<string, number>();
  let submitAccepted = false;
  let submitFailure: string | undefined;
  let submitFailureDetail: string | undefined;
  let submitFeedback: string | undefined;
  let turns = 0;
  const plan = input.units;
  // Unit-mode state. acceptedUnits holds schema-parsed submit arguments keyed by
  // unit id; assembly reads them back in expectedUnitIds order, so submission
  // order never reaches the assembled output. errorOccurrences keys are
  // `unit:${id}|${errorKey}` for per-unit shape errors and `run:${errorKey}` for
  // run-level behavior (missing submit, raw JSON, unknown unit id).
  const acceptedUnits = new Map<string, unknown>();
  const sealedUnits = new Map<string, SealedUnit>();

  const expected = plan?.expectedUnitIds ?? [];
  const remainingIds = (): string[] =>
    expected.filter((id) => !acceptedUnits.has(id) && !sealedUnits.has(id));
  const allTerminal = (): boolean =>
    expected.every((id) => acceptedUnits.has(id) || sealedUnits.has(id));
  const fullCoverage = (): boolean =>
    expected.length > 0 && expected.every((id) => acceptedUnits.has(id));

  function unitSummary(): string {
    const accepted = expected.filter((id) => acceptedUnits.has(id));
    const sealed = [...sealedUnits.entries()]
      .filter(([id]) => expected.includes(id))
      .map(([id, seal]) => `${id} x${seal.occurrences}: ${oneLine(seal.error)}`);
    const outstanding = expected.filter((id) => !acceptedUnits.has(id) && !sealedUnits.has(id));
    return (
      `units accepted ${accepted.length}/${expected.length}` +
      (accepted.length ? ` [${accepted.join(',')}]` : '') +
      (sealed.length ? `; sealed [${sealed.join('; ')}]` : '') +
      (outstanding.length ? `; not submitted [${outstanding.join(',')}]` : '')
    );
  }

  function failRun(reason: string, detail: string): { action: 'end' } {
    submitFailure = reason;
    submitFailureDetail = detail;
    console.info(
      '[structured_submit_unit_summary]',
      JSON.stringify({ task_run_id: input.runId, closure: reason, summary: detail }),
    );
    return { action: 'end' as const };
  }

  function rewriteToolResults(
    toolResults: AgentTurnContext['toolResults'],
    feedback: string,
    isError: boolean,
  ): void {
    for (const result of toolResults) {
      result.isError = isError;
      result.content = [{ type: 'text', text: feedback }];
    }
  }

  function countOccurrence(key: string): number {
    const occurrences = (errorOccurrences.get(key) ?? 0) + 1;
    errorOccurrences.set(key, occurrences);
    return occurrences;
  }

  function logTurn(
    message: AgentTurnContext['message'],
    accepted: boolean,
    extra: Record<string, unknown>,
  ): void {
    console.info(
      '[structured_submit_turn]',
      JSON.stringify({
        task_run_id: input.runId,
        turn: ++turns,
        input_tokens: message.usage.input,
        output_tokens: message.usage.output,
        cache_read_tokens: message.usage.cacheRead,
        estimated_cost_usd: message.usage.cost?.total,
        accepted,
        ...extra,
      }),
    );
  }

  return {
    get accepted() {
      return plan ? fullCoverage() : submitAccepted;
    },
    get failure() {
      return submitFailure;
    },
    get failureDetail() {
      return submitFailureDetail;
    },
    /** Assembled full output; defined only when every expected unit was accepted. */
    assembled(): unknown | undefined {
      if (!plan || !fullCoverage()) return undefined;
      return plan.assemble(expected.map((id) => acceptedUnits.get(id) as unknown));
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
      const hash = outputHash(
        rawArguments,
        calls.length
          ? calls.map((call) => call.arguments)
          : message.content.filter((block) => block.type === 'text').map((block) => block.text),
      );

      // ── YUK-1904 unit mode: accept/seal per unit, assemble on full coverage. ──
      if (plan) {
        const landUnit = (id: string): { action: 'end' } | { action: 'continue' } => {
          acceptedUnits.set(id, parsed.data);
          // Unit progress re-arms the run-level abandonment watch (missing
          // submit / raw JSON / unknown id): steady unit progress is not a
          // no-progress run.
          for (const key of [...errorOccurrences.keys()])
            if (key.startsWith('run:')) errorOccurrences.delete(key);
          if (!fullCoverage()) {
            const remaining = remainingIds();
            logTurn(message, true, {
              unit: id,
              event: 'unit_accepted',
              remaining: remaining.length,
            });
            if (allTerminal()) {
              // Every unit is now terminal but some are sealed: no further
              // submit can change the outcome — end the unsuccessful run now
              // instead of collecting sealed-resubmit turns.
              return failRun('no_progress', unitSummary());
            }
            rewriteToolResults(
              toolResults,
              `Unit ${id} accepted. Remaining units: ${remaining.join(', ')}.`,
              false,
            );
            submitFeedback = `Unit ${id} accepted. Continue with the remaining units: ${remaining.join(', ')}.`;
            return { action: 'continue' as const };
          }
          const assembled = plan.assemble(
            expected.map((unit) => acceptedUnits.get(unit) as unknown),
          );
          const fullParsed = input.fullSchema?.safeParse(assembled);
          if (fullParsed && !fullParsed.success) {
            logTurn(message, false, { unit: id, event: 'assembly_invalid' });
            return failRun(
              'validation_failed',
              `assembled output failed the full output schema: ${oneLine(
                structuredSubmitShapeErrors(input.parameters, fullParsed.error.issues).join('\n'),
              )}`,
            );
          }
          logTurn(message, true, { unit: id, event: 'all_units_accepted', remaining: 0 });
          rewriteToolResults(toolResults, `Unit ${id} accepted. All units accepted.`, false);
          return { action: 'end' as const };
        };

        const rejectUnit = (
          id: string | undefined,
          errorKey: string,
          feedback: string,
          event: string,
        ): { action: 'end' } | { action: 'continue' } => {
          // A redactor coverage gap must never surface as an empty tool result.
          const text =
            feedback ||
            'Submit arguments failed shape validation; use the declared fields and types.';
          const occurrences = countOccurrence(
            id === undefined ? `run:${errorKey}` : `unit:${id}|${errorKey}`,
          );
          console.info(
            '[structured_submit_validation]',
            JSON.stringify({
              task_run_id: input.runId,
              unit: id ?? null,
              output_hash: hash,
              error_occurrences: occurrences,
              diagnostics: text,
            }),
          );
          logTurn(message, false, { unit: id ?? null, event, remaining: remainingIds().length });
          if (id !== undefined && occurrences >= 3) {
            if (!sealedUnits.has(id)) sealedUnits.set(id, { error: errorKey, occurrences });
            if (allTerminal() && !fullCoverage()) {
              return failRun('no_progress', unitSummary());
            }
            const remaining = remainingIds();
            const sealedFeedback =
              `${text}\nUnit ${id} is sealed after ${occurrences} identical errors and can no longer be ` +
              `accepted. Continue with the remaining units: ${remaining.join(', ')}.`;
            rewriteToolResults(toolResults, sealedFeedback, true);
            submitFeedback = sealedFeedback;
            return { action: 'continue' as const };
          }
          if (id === undefined && occurrences >= 3) {
            return failRun('no_progress', `${oneLine(errorKey)} x${occurrences}; ${unitSummary()}`);
          }
          if (Date.now() >= input.correctionDeadline) {
            return failRun('budget_landing', unitSummary());
          }
          rewriteToolResults(toolResults, text, true);
          submitFeedback = text;
          return { action: 'continue' as const };
        };

        if (invalidStructuredArguments) {
          const feedback = `Arguments must be one complete strictly valid JSON object${rawArguments
            .filter((raw): raw is string => raw !== undefined)
            .map(jsonSyntaxLocation)
            .join('')}; resubmit without truncation or trailing commas.`;
          return rejectUnit(undefined, 'raw_json', feedback, 'raw_json_invalid');
        }
        if (verdict !== 'landed') {
          return rejectUnit(
            undefined,
            'missing_submit',
            STRUCTURED_SUBMIT_UNIT_REMINDER,
            'missing_submit',
          );
        }
        const { id } = plan.unitOf(candidate);
        if (typeof id !== 'string') {
          const errors = parsed.success
            ? ['unit id: missing from the submitted object']
            : structuredSubmitShapeErrors(input.parameters, parsed.error.issues, candidate);
          return rejectUnit(
            undefined,
            errors.join('\n'),
            errors.sort().join('\n'),
            'unit_id_missing',
          );
        }
        if (!expected.includes(id)) {
          const feedback = `Unknown unit id. Submit only declared input unit ids. Remaining units: ${remainingIds().join(', ')}.`;
          return rejectUnit(undefined, 'unknown_unit_id', feedback, 'unknown_unit_id');
        }
        if (acceptedUnits.has(id)) {
          // Accepted units are never rewritten; the wasted call is reported but
          // does not count toward any unit's shape-error budget.
          logTurn(message, false, {
            unit: id,
            event: 'already_accepted',
            remaining: remainingIds().length,
          });
          if (Date.now() >= input.correctionDeadline) {
            return failRun('budget_landing', unitSummary());
          }
          const feedback = `Unit ${id} was already accepted and was not rewritten. Do not resubmit it. Remaining units: ${remainingIds().join(', ')}.`;
          rewriteToolResults(toolResults, feedback, true);
          submitFeedback = feedback;
          return { action: 'continue' as const };
        }
        if (sealedUnits.has(id)) {
          const feedback = `Unit ${id} is sealed after repeated identical shape errors and can no longer be accepted. Continue with: ${remainingIds().join(', ')}.`;
          return rejectUnit(id, 'sealed_resubmit', feedback, 'sealed_resubmit');
        }
        if (!parsed.success) {
          const errors = structuredSubmitShapeErrors(
            input.parameters,
            parsed.error.issues,
            candidate,
          );
          return rejectUnit(id, errors.join('\n'), errors.sort().join('\n'), 'shape_rejected');
        }
        const unitErrors = [...(plan.validateUnit?.(parsed.data, input.taskInput) ?? [])];
        if (unitErrors.length > 0) {
          return rejectUnit(
            id,
            unitErrors.join('\n'),
            unitErrors.sort().join('\n'),
            'validate_rejected',
          );
        }
        return landUnit(id);
      }

      // ── Whole-output mode (#2533 semantics, unchanged). ──
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
            : [];
      const accepted = errors.length === 0 && toolResults.length === 1 && !toolResults[0]?.isError;
      logTurn(message, accepted, {});
      if (accepted) {
        submitAccepted = true;
        return { action: 'end' as const };
      }
      // Replace native pi/Ajv diagnostics, which may echo received values.
      const feedback = errors.length
        ? errors.sort().join('\n')
        : 'Submit arguments failed shape validation; use the declared fields and types.';
      rewriteToolResults(toolResults, feedback, true);
      const errorKey =
        !invalidStructuredArguments && verdict === 'landed' && !parsed.success
          ? structuredSubmitShapeErrors(input.parameters, parsed.error.issues).join('\n')
          : feedback.replace(/character \d+/g, 'character [position]');
      const occurrences = countOccurrence(errorKey);
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

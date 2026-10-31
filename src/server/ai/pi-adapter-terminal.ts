// Terminal result assembly for the pi execution adapter: one pi child usage
// ledger and the SDK result frame that closes a run. Usage summed here is this
// invocation's own spend; caller-abort still yields no terminal frame.

import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  Api as PiApi,
  AssistantMessage as PiAssistantMessage,
  Model as PiModel,
  Usage as PiUsage,
} from '@earendil-works/pi-ai';
import type { PiRunnerMessage } from './execution-adapter';
import {
  EMPTY_PI_USAGE,
  assistantText,
  lastAssistantMessage,
  piStopReasonToSdk,
  piUsageToSdk,
} from './pi-adapter-frames';
import { hasPiUsageEvidence } from './pi-usage-evidence';
import type { ProviderErrorEvidence } from './provider-error-evidence';
import type { SDKResultMessage } from './sdk-types';
import { STRUCTURED_OUTPUT_SUBMIT_TOOL } from './structured-submit';

function piUsageToResultUsage(usage: PiUsage | undefined, model: PiModel<PiApi>) {
  return {
    usage: piUsageToSdk(usage),
    // The model entry carries THIS loop's own spend only — nested-child usage
    // is merged in by the caller (piTerminalResultFrame), which would double
    // count if the combined run total were baked in here.
    modelUsage: {
      [model.id]: {
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        cacheReadInputTokens: usage?.cacheRead ?? 0,
        cacheCreationInputTokens: usage?.cacheWrite ?? 0,
        webSearchRequests: 0,
        costUSD: usage?.cost?.total ?? 0,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
      },
    },
  };
}
/**
 * Build the terminal result frame. Returns undefined on caller abort: the absent
 * terminal frame is what lets the lifecycle's `aborted` truth win.
 */
export function piTerminalResultFrame(args: {
  messages: AgentMessage[];
  model: PiModel<PiApi>;
  sessionId: string;
  durationMs: number;
  numTurns: number;
  aborted: boolean;
  /** Set when finishTurn hit the turn ceiling ('error_max_turns'). */
  cappedByMaxTurns?: boolean;
  /** Only the opt-in structured task uses tool arguments as its terminal result. */
  structuredOutputTool?: boolean;
  /** Reject pi best-effort JSON salvage: streamed arguments must parse strictly. */
  invalidStructuredArguments?: boolean;
  /** YUK-1547 — the run's ONE shared landing turn was already consumed and the
   *  submit still did not land; the name is reported in the terminal error. */
  submitLandingConsumedBy?: 'missing_submit' | 'param_contract';
  /** YUK-1547 (C1) — submit arguments AFTER the shared parameter-contract repair,
   *  i.e. what validation and execute saw. Raw streamed bytes stay the evidence. */
  repairedSubmitArguments?: unknown;
  /** Bounded raw-arguments evidence for the structured-failure terminal. */
  structuredSubmitEvidence?: {
    tool_name: string;
    raw_arguments: string;
    raw_args_sha256: string;
    truncated: boolean;
  };
  /** YUK-1559 (C6) — sanitized provider error body from the query's fetch; it
   *  rides errors[] so the raw non-2xx body reaches error_message. */
  providerError?: ProviderErrorEvidence;
  /** Safe rejection bound to the same final root assistant, never query.latest. */
  providerRequestRejection?: { http_status: 400 };
  /** YUK-1559 (C6) — the capture's shared sanitize+bound for retained provider
   *  text, applied to pi's errorMessage (errors[0]) so the full unsanitized body
   *  cannot bypass credential redaction or the 4096B cap. */
  sanitizeErrorMessage?: (text: string) => string;
  /** Nested-child usage merged into the terminal totals (SDK result parity). */
  childUsage?: PiChildUsage;
}): PiRunnerMessage | undefined {
  const final = lastAssistantMessage(args.messages);
  const base = {
    source: 'pi' as const,
    type: 'result' as const,
    usage_observed:
      args.messages.some(
        (message) =>
          message.role === 'assistant' && hasPiUsageEvidence(message as PiAssistantMessage),
      ) ||
      [
        args.childUsage?.input,
        args.childUsage?.output,
        args.childUsage?.cacheRead,
        args.childUsage?.cacheWrite,
        args.childUsage?.costUsd,
      ].some((value) => value !== undefined && value > 0),
    duration_ms: args.durationMs,
    duration_api_ms: args.durationMs,
    num_turns: Math.max(1, args.numTurns),
    permission_denials: [],
    uuid: randomUUID(),
    session_id: args.sessionId,
  };
  // agent_end contains this invocation's messages (not replay history). Pi usage
  // is per response, so sum every root turn before adding nested-loop spend.
  const usage: PiUsage = { ...EMPTY_PI_USAGE, cost: { ...EMPTY_PI_USAGE.cost } };
  for (const message of args.messages) {
    if (message.role !== 'assistant' || !message.usage) continue;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
      usage[key] += message.usage[key];
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
      usage.cost[key] += message.usage.cost[key];
    }
  }
  const child = args.childUsage;
  const costUsd = (usage?.cost?.total ?? 0) + (child?.costUsd ?? 0);
  const usageParts = piUsageToResultUsage(usage, args.model);
  // YUK-1559 (C6) — the captured non-2xx body rides as its own errors[] entry
  // so it survives verbatim; errors[0] stays pi's formatted message.
  const providerErrorEntry =
    args.providerError !== undefined
      ? `provider_http_error=${JSON.stringify(args.providerError)}`
      : undefined;
  const errorEntry = args.sanitizeErrorMessage ?? ((text: string) => text);
  if (child && (child.input > 0 || child.output > 0)) {
    usageParts.usage.input_tokens += child.input;
    usageParts.usage.output_tokens += child.output;
    usageParts.usage.cache_read_input_tokens += child.cacheRead;
    usageParts.usage.cache_creation_input_tokens += child.cacheWrite;
    for (const [modelId, entry] of child.byModel) {
      const existing = usageParts.modelUsage[modelId];
      if (existing) {
        existing.inputTokens += entry.inputTokens;
        existing.outputTokens += entry.outputTokens;
        existing.cacheReadInputTokens += entry.cacheReadInputTokens;
        existing.cacheCreationInputTokens += entry.cacheCreationInputTokens;
        existing.costUSD += entry.costUSD;
      } else {
        usageParts.modelUsage[modelId] = entry;
      }
    }
  }

  if (args.aborted || final?.stopReason === 'aborted') {
    if (args.aborted) return undefined;
    // Provider-side abort without our signal is an engine error, not caller
    // cancellation — surface it as a terminal error.
    return {
      ...base,
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      total_cost_usd: costUsd,
      errors: [
        errorEntry(final?.errorMessage ?? 'pi agent aborted by provider'),
        ...(providerErrorEntry ? [providerErrorEntry] : []),
      ],
      ...usageParts,
    } as SDKResultMessage & { source: 'pi' };
  }
  if (!final) {
    return {
      ...base,
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      total_cost_usd: 0,
      errors: [
        errorEntry('pi agent_loop ended without an assistant message'),
        ...(providerErrorEntry ? [providerErrorEntry] : []),
      ],
      ...usageParts,
    } as SDKResultMessage & { source: 'pi' };
  }
  if (args.cappedByMaxTurns) {
    return {
      ...base,
      subtype: 'error_max_turns',
      is_error: true,
      stop_reason: null,
      total_cost_usd: costUsd,
      errors: [`pi agent_loop stopped at the configured turn ceiling (${args.numTurns})`],
      ...usageParts,
    } as SDKResultMessage & { source: 'pi' };
  }
  if (final.stopReason === 'error') {
    return {
      ...base,
      subtype: 'error_during_execution',
      ...(args.providerRequestRejection
        ? { provider_request_rejection: args.providerRequestRejection }
        : {}),
      is_error: true,
      stop_reason: null,
      total_cost_usd: costUsd,
      errors: [
        errorEntry(final.errorMessage ?? 'pi stream error'),
        ...(providerErrorEntry ? [providerErrorEntry] : []),
      ],
      ...usageParts,
    } as SDKResultMessage & { source: 'pi' };
  }
  let structuredOutput: unknown;
  if (args.structuredOutputTool) {
    const calls = final.content.filter((block) => block.type === 'toolCall');
    const call = calls[0];
    const arguments_ = call?.arguments;
    if (
      args.invalidStructuredArguments ||
      final.stopReason !== 'toolUse' ||
      calls.length !== 1 ||
      call?.name !== STRUCTURED_OUTPUT_SUBMIT_TOOL ||
      arguments_ == null
    ) {
      return {
        ...base,
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: null,
        total_cost_usd: costUsd,
        ...usageParts,
        // The raw-args digest lands in error_message and unresolved_reason so
        // the truncated tool_call_log evidence can be matched back to this run.
        errors: [
          'structured output requires exactly one non-truncated submit call with strictly valid raw JSON arguments; no text fallback' +
            (args.submitLandingConsumedBy === 'missing_submit'
              ? '; the single landing turn was already consumed by the missing-submit reminder without a submit'
              : args.submitLandingConsumedBy === 'param_contract'
                ? '; the single landing turn was already consumed by the parameter-contract correction without a submit'
                : '') +
            (args.structuredSubmitEvidence
              ? `;raw_args_sha256=${args.structuredSubmitEvidence.raw_args_sha256}`
              : ''),
        ],
        ...(args.structuredSubmitEvidence
          ? { structured_submit_evidence: args.structuredSubmitEvidence }
          : {}),
      } as SDKResultMessage & { source: 'pi' };
    }
    // YUK-1547 — the submit call's arguments ARE the structured output; there is
    // no {result: ...} envelope. When the parameter-contract repair was adopted
    // the capability sees the REPAIRED arguments; raw streamed bytes stay the
    // tool_call_log evidence.
    structuredOutput = args.repairedSubmitArguments ?? arguments_;
  }
  return {
    ...base,
    subtype: 'success',
    is_error: false,
    result: assistantText(final),
    stop_reason: piStopReasonToSdk(final.stopReason),
    total_cost_usd: costUsd,
    structured_output: structuredOutput,
    ...usageParts,
  } as SDKResultMessage & { source: 'pi' };
}

/** Nested-child usage rolled into the parent terminal (SDK result parity). */
export interface PiChildUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  byModel: Map<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      webSearchRequests: number;
      costUSD: number;
      contextWindow: number;
      maxOutputTokens: number;
    }
  >;
}

export function emptyPiChildUsage(): PiChildUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, byModel: new Map() };
}

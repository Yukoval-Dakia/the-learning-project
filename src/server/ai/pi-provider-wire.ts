// Pi provider wire policy.
//
// One owner for what every loop level (root + nested) puts on the provider wire:
// auth/headers/retries/reasoning/timeout from the resolved binding, the attempt's
// budgeted fetch and non-2xx capture, the context-token ceiling, and the
// structured-submit tool_choice fields. The agent loop consumes `streamFn` and
// `loopConfig`; the terminal reads `latestProviderError`/`sanitizeErrorMessage`.

import type { AgentLoopConfig, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type {
  Api as PiApi,
  Model as PiModel,
  MutableModels as PiMutableModels,
} from '@earendil-works/pi-ai';
import { tracePiStream } from './laminar-tracing';
import { createPiLlmMessageConverter, estimatePiTokens } from './pi-context-policy';
import type { LoomPiModel } from './pi-models';
import { withPiUsageEvidence } from './pi-usage-evidence';
import { createProviderErrorCaptureFetch } from './provider-error-evidence';
import {
  OPENAI_SDK_DEFAULT_TIMEOUT_MS,
  PROVIDER_HTTP_TIMEOUT_MARGIN_MS,
  providerHttpTimeoutMs,
} from './provider-http-timeout';
import { createBudgetedProviderFetch } from './provider-transport';
import type { ResolvedProvider } from './providers';
import { reasoningModelView } from './reasoning-wire';
import type { Options } from './sdk-types';
import {
  type StructuredSubmitPolicy,
  resolveStructuredSubmitPolicy,
  structuredSubmitWireFields,
} from './structured-submit';

export interface PiProviderWireInput {
  runId: string;
  resolved: ResolvedProvider;
  options: Pick<Options, 'providerTimeoutMs' | 'transportEvidence' | 'effort' | 'judgeRetryPolicy'>;
  streamSimple: PiMutableModels['streamSimple'];
  /** Bridge-owned inputs whose canonical schema reaches the provider. */
  wireParameters: ReadonlyMap<string, AgentTool['parameters']>;
  /** The kind mounts the structured-output submit tool. */
  structuredOutput: boolean;
  /** Read per loop level: an operator config change applies to nested loops too. */
  readMaxRetries: () => number | undefined;
}

const OPENCODE_SESSION_HEADER = 'x-opencode-session';

export class PiProviderWire {
  private providerHttp: { fetch: typeof fetch; close: () => Promise<void> } | undefined;
  /** YUK-1559 (C6) — non-2xx capture fetch, created lazily in loopConfig. */
  private providerErrorCapture: ReturnType<typeof createProviderErrorCaptureFetch> | undefined;

  constructor(private readonly input: PiProviderWireInput) {}

  private secrets(): string[] {
    const { resolved } = this.input;
    return resolved.authMode !== 'oauth-file' && resolved.apiKey ? [resolved.apiKey] : [];
  }

  /**
   * YUK-1630 — every provider request runs through the attempt's controlled
   * transport (budget-derived connect/headers/body timers). Unset timeoutMs
   * derives from the SDK's 10-minute default so undici stays consistent with it.
   */
  private providerTransport(): { timeoutMs?: number; fetch: typeof fetch } {
    const timeoutMs = this.input.options.providerTimeoutMs;
    const collector = this.input.options.transportEvidence;
    this.providerHttp ??= createBudgetedProviderFetch({
      httpTimeoutMs: timeoutMs ?? providerHttpTimeoutMs(OPENAI_SDK_DEFAULT_TIMEOUT_MS),
      marginMs: PROVIDER_HTTP_TIMEOUT_MARGIN_MS,
      secrets: this.secrets(),
      ...(collector !== undefined ? { collector } : {}),
    });
    collector?.noteSdkTimeout(
      timeoutMs !== undefined
        ? { sdkTimeoutMs: timeoutMs, source: 'task_budget' }
        : { sdkTimeoutMs: OPENAI_SDK_DEFAULT_TIMEOUT_MS, source: 'sdk_default' },
    );
    return {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      fetch: this.providerHttp.fetch,
    };
  }

  /** Shared config fields every loop level (root + nested) reuses. */
  loopConfig(): Pick<
    AgentLoopConfig,
    'convertToLlm' | 'headers' | 'apiKey' | 'reasoning' | 'timeoutMs' | 'fetch'
  > {
    const { options, resolved, runId } = this.input;
    const http = this.providerTransport();
    // YUK-1559 (C6) — every provider request funnels through a capture fetch so a
    // non-2xx leaves a bounded, sanitized body + status + request id for the
    // terminal error evidence. Passthrough otherwise; it only reads a clone.
    this.providerErrorCapture ??= createProviderErrorCaptureFetch(http.fetch, {
      // The request's resolved credential — redacted at the shared boundary.
      secrets: this.secrets(),
    });
    return {
      // All prompts are standard LLM messages; UI-only AgentMessages never reach
      // this lane (loom owns the durable transcript).
      convertToLlm: createPiLlmMessageConverter(),
      // opencode-go requires this header (400 MissingSessionID without it); it
      // is scoped to that lane so no stray header reaches other providers
      // (YUK-1027).
      ...(resolved.provider === 'opencode-go'
        ? { headers: { [OPENCODE_SESSION_HEADER]: runId } }
        : {}),
      // Per-request credential resolved once in resolveTaskProvider for all auth
      // modes (oauth carries the sk-ant-oat* token → Bearer; oauth-file carries
      // no apiKey — auth resolves through the file-backed credential store).
      apiKey: resolved.authMode !== 'oauth-file' ? resolved.apiKey : undefined,
      // YUK-590 parity: cap provider retries so a persistent 5xx returns control
      // to loom's deliberate retry layer. An explicit operator '0' is preserved.
      ...(options.judgeRetryPolicy === 'none'
        ? { maxRetries: 0 }
        : this.input.readMaxRetries() !== undefined
          ? { maxRetries: this.input.readMaxRetries() }
          : {}),
      // options.effort is the caller channel; task.<kind>.reasoning resolves to
      // exactly one pi level — startup rejects both being set (one wire writer).
      ...(options.effort !== undefined ? { reasoning: options.effort } : {}),
      ...(resolved.reasoning?.level !== undefined ? { reasoning: resolved.reasoning.level } : {}),
      ...(http.timeoutMs !== undefined ? { timeoutMs: http.timeoutMs } : {}),
      fetch: this.providerErrorCapture.fetch,
    };
  }

  /**
   * YUK-1547 — submit wire policy for this lane. 'forced' pins the named
   * tool_choice; a lane that records the forced choice as wire-rejected degrades
   * to 'auto' + the single closing reminder wired in iterate().
   */
  submitPolicy(model: PiModel<PiApi>): StructuredSubmitPolicy | undefined {
    if (
      !this.input.structuredOutput ||
      (model.api !== 'openai-completions' && model.api !== 'openai-responses')
    ) {
      return undefined;
    }
    return resolveStructuredSubmitPolicy(this.input.resolved.provider, this.input.resolved.model);
  }

  readonly streamFn: StreamFn = (model: LoomPiModel, llmContext, streamOptions) => {
    const wireParameters = this.input.wireParameters;
    const wireContext =
      wireParameters.size === 0
        ? llmContext
        : {
            ...llmContext,
            messages: llmContext.messages.map((message) =>
              message.role === 'system' && message.toolsAdded
                ? {
                    ...message,
                    toolsAdded: message.toolsAdded.map((tool) => {
                      const parameters = wireParameters.get(tool.name);
                      return parameters ? { ...tool, parameters } : tool;
                    }),
                  }
                : message,
            ),
          };
    // The catalog check guards options.effort only: task.<kind>.reasoning levels
    // are already validated/carried by resolveTaskReasoning (toggle carriers are
    // not effort names on the model's list).
    const effort = this.input.options.effort;
    const inputTokens = estimatePiTokens(wireContext.messages);
    const remaining = model.contextWindow - inputTokens;
    streamOptions = {
      ...streamOptions,
      maxTokens: Math.min(streamOptions?.maxTokens ?? model.maxTokens, model.maxTokens, remaining),
    };
    const submitPolicy = this.submitPolicy(model);
    const streamOptionsWithPayload = {
      ...streamOptions,
      onPayload: async (payload: unknown, requestModel: PiModel<PiApi>) => {
        // Pi converts onPayload failures into terminal errors; throwing from streamFn crashes its loop.
        if (
          effort !== undefined &&
          model.catalogReasoning &&
          !model.catalogReasoning.supportedEfforts.includes(effort)
        ) {
          throw new Error(
            `Model '${model.provider}/${model.id}' does not declare reasoning effort '${effort}' in the runtime catalog`,
          );
        }
        if (inputTokens > (model.maxInputTokens ?? model.contextWindow) || remaining <= 0) {
          throw new Error(
            `Model '${model.provider}/${model.id}' input exceeds its catalog token limit`,
          );
        }
        const transformed = await streamOptions?.onPayload?.(payload, requestModel);
        const body = transformed ?? payload;
        if (submitPolicy === undefined) return body;
        if (body == null || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('structured output requires an object provider payload');
        }
        return {
          ...body,
          ...structuredSubmitWireFields(
            submitPolicy,
            model.api === 'openai-responses' ? 'openai-responses' : 'openai-completions',
          ),
        };
      },
    };
    return tracePiStream(
      (m, context, options) =>
        withPiUsageEvidence(
          (innerModel, innerContext, innerOptions) =>
            this.input.streamSimple(innerModel, innerContext, innerOptions),
          m,
          context,
          options,
        ),
      // Request-scoped model view: unconfigured reasoning must not emit
      // thinking:{disabled}; an explicit 'off' must stay expressible.
      reasoningModelView(model, this.input.resolved.reasoning, effort),
      wireContext,
      streamOptionsWithPayload,
    );
  };

  /** Last non-2xx this query's capture fetch saw, if any (C6 terminal evidence). */
  latestProviderError(): ReturnType<ReturnType<typeof createProviderErrorCaptureFetch>['latest']> {
    return this.providerErrorCapture?.latest();
  }

  /** The capture's shared sanitize+bound for retained provider text. */
  sanitizeErrorMessage(): ((text: string) => string) | undefined {
    return this.providerErrorCapture?.sanitize;
  }

  async close(): Promise<void> {
    const providerHttp = this.providerHttp;
    this.providerHttp = undefined;
    await providerHttp?.close().catch(() => {});
  }
}

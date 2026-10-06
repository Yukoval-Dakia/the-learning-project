import { AsyncLocalStorage } from 'node:async_hooks';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { hasPiUsageEvidence } from './pi-usage-evidence';

type Sdk = typeof import('@lmnr-ai/lmnr');
type SpanName =
  | 'task.run'
  | 'task.attempt'
  | 'llm.call'
  | 'tool.execute'
  | 'tool.attempt'
  | 'agent.child'
  | 'job.run'
  | 'assessment.execute'
  | 'assessment.parse'
  | 'copilot.run'
  | 'copilot.finalize';

export interface TraceMetadata {
  task_kind?: string;
  task_run_id?: string;
  parent_task_run_id?: string;
  logical_run_id?: string;
  provider?: string;
  model?: string;
  tool_name?: string;
  tool_call_id?: string;
  job_name?: string;
  job_id?: string;
  batch_size?: number;
  execution_outcome?: 'success' | 'error' | 'cancelled' | 'not_started';
  business_outcome?: 'unassessed' | 'accepted' | 'rejected' | 'pending' | 'cancelled';
  durable_settled?: boolean;
  executed?: boolean;
  usage_observed?: boolean;
  cost_basis?: string;
  cost_ref?: string;
  aggregate_input_tokens?: number;
  aggregate_output_tokens?: number;
  aggregate_cost_usd?: number;
  includes_child_usage?: boolean;
  additive_usage?: boolean;
}

const metadataKeys = [
  'task_kind',
  'task_run_id',
  'parent_task_run_id',
  'logical_run_id',
  'provider',
  'model',
  'tool_name',
  'tool_call_id',
  'job_name',
  'job_id',
  'batch_size',
  'execution_outcome',
  'business_outcome',
  'durable_settled',
  'executed',
  'usage_observed',
  'cost_basis',
  'cost_ref',
  'aggregate_input_tokens',
  'aggregate_output_tokens',
  'aggregate_cost_usd',
  'includes_child_usage',
  'additive_usage',
] satisfies (keyof TraceMetadata)[];

/** Capability-owned text only. The caller must remove private business data. */
export interface SanitizedTraceText {
  summary: string;
}
export interface TraceContent<T> {
  input?: SanitizedTraceText;
  output?: (result: T) => SanitizedTraceText | undefined;
}

type Attribute = string | number | boolean;
export interface TraceSinkSpan {
  context?: string;
  setAttribute(name: string, value: Attribute): void;
  setStatus(status: { code: number }): void;
  end(): void;
}
export interface TraceExporter {
  start(options: {
    name: SpanName;
    spanType: 'DEFAULT' | 'LLM' | 'TOOL';
    parentContext?: string;
  }): TraceSinkSpan;
  flush(): Promise<void>;
}

let exporter: TraceExporter | undefined;
let initializing: Promise<void> | undefined;
const activeSpan = new AsyncLocalStorage<TraceSpan>();
export const TRACE_FLUSH_TIMEOUT_MS = 500;

export function isLaminarTracingEnabled(): boolean {
  return exporter !== undefined;
}

function telemetry(action: () => void): void {
  try {
    action();
  } catch {
    /* Telemetry never changes business execution. */
  }
}

function metadataAttributes(metadata: TraceMetadata, span: TraceSinkSpan): void {
  for (const key of metadataKeys) {
    const value = metadata[key];
    if (
      (typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,200}$/.test(value)) ||
      (typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
      typeof value === 'boolean'
    )
      span.setAttribute(`lmnr.association.properties.metadata.${key}`, value);
  }
}

function sdkCaptureSettingsAreSafe(): boolean {
  // SDK debug/global context can capture data outside this explicit allowlist.
  if (process.env.LMNR_DEBUG || process.env.LMNR_TRACE_METADATA || process.env.LMNR_SPAN_CONTEXT) {
    console.warn('[laminar] disabled: unsupported SDK debug/global-context settings');
    return false;
  }
  return true;
}

export async function initializeLaminarTracing(
  options: { projectApiKey?: string; loadSdk?: () => Promise<Sdk> } = {},
): Promise<void> {
  const key = options.projectApiKey ?? process.env.LMNR_PROJECT_API_KEY;
  if (!key?.trim() || exporter || !sdkCaptureSettingsAreSafe()) return;
  initializing ??= (async () => {
    try {
      const { Laminar } = await (options.loadSdk ?? (() => import('@lmnr-ai/lmnr')))();
      // SDK import loads dotenv; recheck before creating its tracer/debug runtime.
      if (!sdkCaptureSettingsAreSafe()) return;
      Laminar.initialize({
        projectApiKey: key,
        instrumentModules: {},
        inheritGlobalContext: false,
        traceExportTimeoutMillis: TRACE_FLUSH_TIMEOUT_MS,
        logLevel: 'error',
      });
      exporter = {
        start: ({ name, spanType, parentContext }) => {
          const span = Laminar.startSpan({
            name,
            spanType,
            parentSpanContext: parentContext,
            tags: ['tlp'],
          });
          let serializedContext: string | undefined;
          telemetry(() => {
            serializedContext = Laminar.serializeLaminarSpanContext(span) ?? undefined;
          });
          return {
            context: serializedContext,
            setAttribute: (name, value) => {
              span.setAttribute(name, value);
            },
            setStatus: (status) => {
              span.setStatus(status);
            },
            end: () => {
              span.end();
            },
          };
        },
        flush: () => Laminar.flush(),
      };
    } catch {
      console.warn('[laminar] initialization failed; application continues without tracing');
    }
  })();
  await initializing;
}

export class TraceSpan {
  private ended = false;
  private readonly identities: TraceMetadata = {};
  constructor(private readonly sink?: TraceSinkSpan) {}
  get context(): string | undefined {
    return this.sink?.context;
  }
  get identityMetadata(): TraceMetadata {
    return this.identities;
  }
  metadata(metadata: TraceMetadata | (() => TraceMetadata)): void {
    if (!this.ended && this.sink)
      telemetry(() => {
        const values = typeof metadata === 'function' ? metadata() : metadata;
        if (this.sink) metadataAttributes(values, this.sink);
        for (const key of [
          'task_kind',
          'task_run_id',
          'parent_task_run_id',
          'logical_run_id',
          'job_name',
          'job_id',
        ] satisfies (keyof TraceMetadata)[]) {
          const value = values[key];
          if (typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,200}$/.test(value))
            this.identities[key] = value;
        }
      });
  }
  attribute(name: string, value: Attribute): void {
    if (!this.ended)
      telemetry(() => {
        this.sink?.setAttribute(name, value);
      });
  }
  content(direction: 'input' | 'output', content?: SanitizedTraceText): void {
    if (typeof content?.summary === 'string') {
      this.attribute(
        `lmnr.span.${direction}`,
        JSON.stringify({ summary: content.summary.slice(0, 4000) }),
      );
    }
  }
  end(outcome: 'success' | 'error' | 'cancelled' | 'not_started' = 'success'): void {
    if (this.ended) return;
    this.metadata({ execution_outcome: outcome });
    telemetry(() => {
      this.sink?.setStatus({ code: outcome === 'error' ? 2 : 1 });
    });
    this.ended = true;
    telemetry(() => {
      this.sink?.end();
    });
  }
}

export function startTraceSpan(name: SpanName, metadata: TraceMetadata = {}): TraceSpan {
  let sink: TraceSinkSpan | undefined;
  telemetry(() => {
    sink = exporter?.start({
      name,
      spanType: name === 'llm.call' ? 'LLM' : name.startsWith('tool.') ? 'TOOL' : 'DEFAULT',
      parentContext: activeSpan.getStore()?.context,
    });
  });
  const span = new TraceSpan(sink);
  span.metadata(activeSpan.getStore()?.identityMetadata ?? {});
  span.metadata(metadata);
  return span;
}

export function withTraceContext<T>(span: TraceSpan, callback: () => T): T {
  return activeSpan.run(span, callback);
}

export function traceMetadata(metadata: TraceMetadata): void {
  activeSpan.getStore()?.metadata(metadata);
}

export async function traceOperation<T>(
  name: SpanName,
  metadata: TraceMetadata,
  callback: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    content?: TraceContent<T>;
    outcome?: (result: T) => 'success' | 'error' | 'cancelled';
  } = {},
): Promise<T> {
  if (!exporter) return callback();
  const span = startTraceSpan(name, metadata);
  telemetry(() => {
    span.content('input', options.content?.input);
  });
  return withTraceContext(span, async () => {
    try {
      const result = await callback();
      telemetry(() => {
        span.content('output', options.content?.output?.(result));
      });
      let outcome: 'success' | 'error' | 'cancelled' = 'success';
      telemetry(() => {
        outcome = options.outcome?.(result) ?? 'success';
      });
      span.end(options.signal?.aborted ? 'cancelled' : outcome);
      return result;
    } catch (error) {
      span.end(options.signal?.aborted ? 'cancelled' : 'error');
      throw error;
    }
  });
}

/** Model result() observes completion without consuming the stream twice. */
export async function tracePiStream(
  streamFn: StreamFn,
  ...args: Parameters<StreamFn>
): Promise<Awaited<ReturnType<StreamFn>>> {
  if (!exporter) return streamFn(...args);
  const [model, , options] = args;
  const span = startTraceSpan('llm.call', {
    provider: model.provider,
    model: model.id,
    additive_usage: true,
    usage_observed: false,
    cost_basis: 'unknown',
    cost_ref: `pi-catalog:${model.provider}/${model.id}`,
  });
  span.attribute('gen_ai.system', model.provider);
  span.attribute('gen_ai.request.model', model.id);
  const signal = options?.signal;
  const onAbort = () => span.end('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const stream = await withTraceContext(span, () => streamFn(...args));
    const result = withTraceContext(span, () => stream.result());
    // Keep the original rejection/return value for every caller, even if the exporter fails.
    stream.result = () => result;
    void result.then(
      (message) => {
        telemetry(() => recordPiLlmUsage(span, message));
        span.end(
          signal?.aborted
            ? 'cancelled'
            : message.stopReason === 'error' || message.stopReason === 'aborted'
              ? 'error'
              : 'success',
        );
        signal?.removeEventListener('abort', onAbort);
      },
      () => {
        span.end(signal?.aborted ? 'cancelled' : 'error');
        signal?.removeEventListener('abort', onAbort);
      },
    );
    return stream;
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    span.end(signal?.aborted ? 'cancelled' : 'error');
    throw error;
  }
}

function recordPiLlmUsage(span: TraceSpan, message: AssistantMessage): void {
  span.attribute('gen_ai.response.model', message.model);
  const observed = hasPiUsageEvidence(message);
  span.metadata({
    usage_observed: observed,
    cost_basis: observed ? 'estimated' : 'unknown',
    cost_ref: `pi-catalog:${message.provider}/${message.model}`,
  });
  if (!observed) return;
  const usage = message.usage;
  for (const [name, value] of [
    ['gen_ai.usage.input_tokens', usage.input],
    ['gen_ai.usage.output_tokens', usage.output],
    ['llm.usage.total_tokens', usage.totalTokens],
    ['gen_ai.usage.cache_read_input_tokens', usage.cacheRead],
    ['gen_ai.usage.cache_creation_input_tokens', usage.cacheWrite],
    ['gen_ai.usage.cost', usage.cost.total],
  ] satisfies [string, number][]) {
    if (Number.isFinite(value) && value >= 0) span.attribute(name, value);
  }
}

/** Call only after HTTP/jobs drain. A stalled exporter gets at most 500ms. */
export async function flushLaminarTracing(timeoutMs = TRACE_FLUSH_TIMEOUT_MS): Promise<void> {
  if (!exporter) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => exporter?.flush())
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(TRACE_FLUSH_TIMEOUT_MS, Math.max(0, timeoutMs)));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** No network: unit tests inject their in-memory exporter. */
export function __setTraceExporterForTests(value?: TraceExporter): void {
  exporter = value;
  initializing = undefined;
}

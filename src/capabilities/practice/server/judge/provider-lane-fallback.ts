// Both attempts are pinned, so runner transient retry stays disabled and this
// helper remains the only cross-lane retry layer.

import { type Provider, tasks } from '@/ai/registry';
import { AgentRunError } from '@/server/ai/agent-run-error';
import type { RunTaskCtx } from '@/server/ai/runner';
import { visionJudgeProviderOverride } from '@/server/ai/vision-judge-config';

const PROVIDER_HARD_FAILURE_KIND = 'provider_hard_failure';

interface ProviderHardFailureDetails {
  error_kind: typeof PROVIDER_HARD_FAILURE_KIND;
  /** HTTP status the provider returned; null = connection-class. */
  api_error_status: number | null;
  /** Joined AgentRunError errors (provider refusal detail). */
  error: string;
}

interface ProviderHardFailure extends ProviderHardFailureDetails {
  /** Lane label that hard-failed (configured override or effective default). */
  failed_lane: string;
  /** Present when a fallback-lane attempt was made and also hard-failed. */
  fallback?: {
    lane: string;
    api_error_status: number | null;
    error: string;
  };
}

/**
 * Recognize a provider hard failure (HTTP error / auth / quota / server).
 * Tight by design: ONLY the runner's terminal API-error shape qualifies
 * (subtype 'api_error_result'). Non-API subtypes (error_max_turns,
 * stream_no_terminal, budget_timeout, …) and plain Errors stay in the old
 * semantics — an uncertain failure must not trigger a lane crossing.
 */
function classifyProviderHardFailure(err: unknown): ProviderHardFailureDetails | undefined {
  if (!(err instanceof AgentRunError)) return undefined;
  if (err.subtype !== 'api_error_result') return undefined;
  return {
    error_kind: PROVIDER_HARD_FAILURE_KIND,
    api_error_status: err.apiErrorStatus ?? null,
    error: err.errors.length > 0 ? err.errors.join('; ') : err.message,
  };
}

export interface LaneDegradationEvidence {
  failed_lane: string;
  api_error_status: number | null;
  error: string;
  fallback_lane: Provider;
}

type LaneFallbackRunResult<T> =
  | { ok: true; taskResult: T; laneDegradation?: LaneDegradationEvidence }
  | { ok: false; hardFailure: ProviderHardFailure };

function effectiveUnconfiguredLane(kind: LaneFallbackTaskKind): string {
  return process.env.AI_PROVIDER_OVERRIDE || tasks[kind].defaultProvider;
}

/**
 * The judge tasks served by this helper. Narrowing to this literal union lets
 * the F3.2 task census statically resolve the `runTaskFn(kind, …)` runner calls
 * (type-level string-literal extraction on the destructured identifier) instead
 * of flagging them unresolved.
 */
export type LaneFallbackTaskKind = 'StepsJudgeTask' | 'MultimodalDirectJudgeTask';

export async function runTaskWithLaneFallback<T>({
  kind,
  input,
  /** ctx keys other than `override` (db / subjectProfile / enableTransientRetry / outputFormat). */
  baseCtx,
  runTaskFn,
}: {
  kind: LaneFallbackTaskKind;
  input: unknown;
  baseCtx: Omit<RunTaskCtx, 'override'>;
  runTaskFn: (kind: LaneFallbackTaskKind, input: unknown, ctx: RunTaskCtx) => Promise<T>;
}): Promise<LaneFallbackRunResult<T>> {
  const override = visionJudgeProviderOverride();

  let first: T;
  try {
    first = await runTaskFn(kind, input, { ...baseCtx, override });
    return { ok: true, taskResult: first };
  } catch (err) {
    const hard = classifyProviderHardFailure(err);
    if (!hard) throw err;
    if (!override) {
      return {
        ok: false,
        hardFailure: { ...hard, failed_lane: effectiveUnconfiguredLane(kind) },
      };
    }
    const fallbackOverride = {
      provider: tasks[kind].defaultProvider,
      model: tasks[kind].defaultModel,
    };
    console.warn(
      `[judge-lane] provider lane '${override.provider}' hard-failed (HTTP ${hard.api_error_status ?? 'null'}): ${hard.error} — retrying once on registry-default lane '${fallbackOverride.provider}'`,
    );
    try {
      const second = await runTaskFn(kind, input, {
        ...baseCtx,
        override: fallbackOverride,
      });
      return {
        ok: true,
        taskResult: second,
        laneDegradation: {
          failed_lane: override.provider,
          api_error_status: hard.api_error_status,
          error: hard.error,
          fallback_lane: fallbackOverride.provider,
        },
      };
    } catch (fallbackErr) {
      const fallbackHard = classifyProviderHardFailure(fallbackErr);
      if (!fallbackHard) throw fallbackErr;
      return {
        ok: false,
        hardFailure: {
          ...hard,
          failed_lane: override.provider,
          fallback: {
            lane: fallbackOverride.provider,
            api_error_status: fallbackHard.api_error_status,
            error: fallbackHard.error,
          },
        },
      };
    }
  }
}

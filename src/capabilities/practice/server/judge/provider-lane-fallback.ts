// Both attempts are pinned, so runner transient retry stays disabled and this
// helper remains the only cross-lane retry layer.

import { type Provider, type TaskKind, tasks } from '@/ai/registry';
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

function effectiveUnconfiguredLane(kind: TaskKind): string {
  return process.env.AI_PROVIDER_OVERRIDE || tasks[kind].defaultProvider;
}

export async function runTaskWithLaneFallback<T>(args: {
  kind: TaskKind;
  input: unknown;
  /** ctx keys other than `override` (db / subjectProfile / enableTransientRetry / outputFormat). */
  baseCtx: Omit<RunTaskCtx, 'override'>;
  runTaskFn: (kind: string, input: unknown, ctx: RunTaskCtx) => Promise<T>;
}): Promise<LaneFallbackRunResult<T>> {
  const override = visionJudgeProviderOverride();

  let first: T;
  try {
    first = await args.runTaskFn(args.kind, args.input, { ...args.baseCtx, override });
    return { ok: true, taskResult: first };
  } catch (err) {
    const hard = classifyProviderHardFailure(err);
    if (!hard) throw err;
    if (!override) {
      return {
        ok: false,
        hardFailure: { ...hard, failed_lane: effectiveUnconfiguredLane(args.kind) },
      };
    }
    const fallbackOverride = {
      provider: tasks[args.kind].defaultProvider,
      model: tasks[args.kind].defaultModel,
    };
    console.warn(
      `[judge-lane] provider lane '${override.provider}' hard-failed (HTTP ${hard.api_error_status ?? 'null'}): ${hard.error} — retrying once on registry-default lane '${fallbackOverride.provider}'`,
    );
    try {
      const second = await args.runTaskFn(args.kind, args.input, {
        ...args.baseCtx,
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

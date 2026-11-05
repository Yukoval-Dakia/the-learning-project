// (PR #1063 review, thread 2) — source-grounding verification runner.
// Reuses the multimodal judge INFRA (R2 image fetch + SDK structured-output dispatch,
// same shape as multimodal-direct-judge.ts / steps-judge.ts) but runs a GROUNDING-
// specific prompt (SourceGroundingVerifyTask): re-read the source image and decide
// whether the question 题面 actually appears in it. This is the fix for the threat
// model gap where feeding reference_md as a "student answer" to the answer-correctness
// judge could not catch a VLM that hallucinated a self-consistent 题面 + 答案 unrelated
// to the image.
// Returns a discriminated result so the caller (source_verify.ts) can distinguish:
// - grounded / not_grounded : a real content verdict (not_grounded → demote to draft)
// - transient_error : image fetch / LLM call / output parse failed — NOT a
// content verdict. The caller parks the draft and writes a retriable error.
// - config_error    : lane resolution/auth cannot execute — same non-verdict
// hold, with an error marker the verify outbox can recover after repair.

import { existsSync, readFileSync } from 'node:fs';
import { isProviderAuthConfigError } from '@/ai/agent-run-error';
import { tasks } from '@/capabilities/task-registry';
import { customProviderDefinition } from '@/core/config/custom-providers';
import { getLaneOverride, getTaskOverride, resolveConfigValue } from '@/core/config/store';
import {
  SourceGroundingVerifyOutput,
  type SourceGroundingVerifyOutputT,
} from '@/core/schema/source-grounding';
import type { Db } from '@/db/client';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { executablePiModel } from '@/server/ai/pi-provider-catalog';
import {
  credentialFingerprint,
  providerCredentialFingerprint,
} from '@/server/ai/provider-models-check';
import {
  TaskConfigError,
  providerAuthFileEnvName,
  providerCredentialEnvName,
  readProviderId,
  resolveTaskBinding,
  resolveTaskReasoning,
} from '@/server/ai/providers';
import { applicableVisionJudgeOverride } from '@/server/ai/vision-judge-config';
import type { SubjectProfile } from '@/subjects/profile';
import {
  type StructuredTaskResult,
  defaultStructuredRunTaskFn,
  parseStructuredTaskOutput,
} from './judge-output-parse';
// Reuse the steps@1 R2 image fetcher verbatim — no R2 logic duplicated here.
import { defaultImageFetch } from './steps-judge';

// The registry-declared structuredOutputSchema (the single, audited source) drives the
// app-level Zod parse, mirroring the multimodal/steps judges; lanes without a transport
// contract fall back to the char-scan text parse (zero-loss).

// Concrete `{ text, images }` input (NOT `... | unknown`, which collapses the whole union
// to `unknown` and erases the documented shape — PR #1063 review thread 8).
export type SourceGroundingRunTaskFn = (
  kind: string,
  input: { text: string; images: Array<{ data: string; mediaType: string }> },
  ctx: Parameters<typeof defaultStructuredRunTaskFn>[2],
) => Promise<StructuredTaskResult>;

export type SourceGroundingImageFetchFn = (
  assetIds: string[],
  db: Db,
) => Promise<Array<{ data: string; mediaType: string }>>;

export interface RunSourceGroundingVerifyParams {
  db: Db;
  prompt_md: string;
  reference_md: string | null;
  /** The source_asset row id the question was extracted from (image_candidate materialized rows). */
  sourceAssetId: string;
  subjectProfile: SubjectProfile;
  runTaskFn?: SourceGroundingRunTaskFn;
  imageFetchFn?: SourceGroundingImageFetchFn;
}

/**
 * Run the runner's own lane resolution + adapter startup for this task without
 * submitting a prompt. source_verify calls this before solve_check so a broken
 * grounding lane is proven before the paid-effect send boundary.
 */
export async function assertSourceGroundingLaneConfigured(input: {
  db: Db;
  subjectProfile: SubjectProfile;
}): Promise<void> {
  try {
    const { preflightTaskExecution } = await import('@/server/ai/runner');
    await preflightTaskExecution(
      'SourceGroundingVerifyTask',
      { text: '{}', images: [] },
      {
        db: input.db,
        subjectProfile: input.subjectProfile,
        override: applicableVisionJudgeOverride(),
      },
    );
  } catch (error) {
    if (error instanceof TaskConfigError) throw error;
    if (isProviderAuthConfigError(error)) {
      throw new TaskConfigError(error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * Non-secret identity of the lane's configuration surface. A config_error event
 * records this value; the recovery sweep only re-arms that error epoch after the
 * identity changes. Credential material contributes only a SHA-256 prefix.
 */
export function sourceGroundingLaneFingerprint(
  env: Record<string, string | undefined> = process.env,
): string {
  const kind = 'SourceGroundingVerifyTask' as const;
  const definition = tasks[kind];
  const globalLane = getLaneOverride('global', env);
  const visionLane = getLaneOverride('vision_judge', env);
  const taskOverride = getTaskOverride(kind);
  const scopedOverride = applicableVisionJudgeOverride(env, { checkCredentials: false });
  const bindingResult = (() => {
    try {
      const binding = resolveTaskBinding(kind, scopedOverride);
      const reasoning = (() => {
        try {
          return {
            resolved: resolveTaskReasoning(
              kind,
              binding.provider,
              binding.model,
              binding.reasoning,
            ),
          };
        } catch (error) {
          return { error: error instanceof Error ? error.name : String(error) };
        }
      })();
      const executable = (() => {
        try {
          return { facts: executablePiModel(binding.provider, binding.model, env) ?? null };
        } catch (error) {
          return { error: error instanceof Error ? error.name : String(error) };
        }
      })();
      return { binding, reasoning, executable };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'unknown', message: String(error) },
      };
    }
  })();
  const providerCandidates = [
    env.AI_PROVIDER_OVERRIDE,
    scopedOverride?.provider,
    visionLane?.provider,
    globalLane?.provider,
    taskOverride?.provider,
    definition.defaultProvider,
    'binding' in bindingResult && bindingResult.binding !== undefined
      ? bindingResult.binding.provider
      : undefined,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort();
  const credentials = [...new Set(providerCandidates)].map((configuredAs) => {
    const provider = readProviderId(configuredAs);
    const authFileEnv = provider ? providerAuthFileEnvName(provider) : undefined;
    const authFilePath = authFileEnv ? env[authFileEnv] : undefined;
    const authFile = authFileEnv
      ? {
          env_name: authFileEnv,
          configured: authFilePath !== undefined,
          path_fingerprint: authFilePath !== undefined ? credentialFingerprint(authFilePath) : null,
          content_fingerprint: (() => {
            if (authFilePath === undefined || !existsSync(authFilePath)) return null;
            try {
              return credentialFingerprint(readFileSync(authFilePath, 'utf8'));
            } catch {
              return null;
            }
          })(),
        }
      : null;
    const definition = provider ? customProviderDefinition(provider) : undefined;
    return {
      configured_as: configuredAs,
      provider: provider ?? null,
      credential_env_name: provider ? (providerCredentialEnvName(provider) ?? null) : null,
      credential_fingerprint: provider ? providerCredentialFingerprint(provider, env) : null,
      auth_file: authFile,
      custom_provider: definition
        ? {
            id: definition.id,
            base_url: definition.baseUrl,
            api_key_env: definition.apiKeyEnv,
            protocol: definition.protocol,
            display_name: definition.displayName,
          }
        : null,
    };
  });
  return sha256CanonicalJson({
    version: 1,
    kind,
    env: {
      AI_PROVIDER_OVERRIDE: env.AI_PROVIDER_OVERRIDE ?? null,
      AI_PROVIDER_MODEL: env.AI_PROVIDER_MODEL ?? null,
      VISION_JUDGE_PROVIDER: env.VISION_JUDGE_PROVIDER ?? null,
      VISION_JUDGE_MODEL: env.VISION_JUDGE_MODEL ?? null,
    },
    lane: {
      global: globalLane ?? null,
      vision_judge: visionLane ?? null,
      global_reasoning: resolveConfigValue('lane.global.reasoning', env).value ?? null,
    },
    task: {
      default_provider: definition.defaultProvider,
      default_model: definition.defaultModel,
      ignore_global_pin: definition.ignoreGlobalPin === true,
      override: taskOverride,
      scoped_override: scopedOverride ?? null,
    },
    binding: bindingResult,
    credentials,
  });
}

export type SourceGroundingVerifyResult =
  | { status: 'grounded'; confidence: number; observed_md: string; reason_md: string }
  | { status: 'not_grounded'; confidence: number; observed_md: string; reason_md: string }
  | { status: 'transient_error'; message: string }
  | { status: 'config_error'; message: string };

/**
 * Three-state dispatch over the task result (mirrors the multimodal/steps judges):
 * structured_output present → Zod-parse it (the Zod pass is NOT optional — outputFormat
 * only guarantees JSON shape, not the app-level constraints); absent → char-scan the
 * text. `.parse` (throwing) is kept so a malformed output surfaces as a transient_error
 * in the caller rather than a silent grounded/not_grounded. Exported for the unit test.
 */
export function parseSourceGroundingResult(
  result: StructuredTaskResult,
): SourceGroundingVerifyOutputT {
  return parseStructuredTaskOutput(
    result,
    SourceGroundingVerifyOutput,
    'source_grounding_verify output',
  );
}

export async function runSourceGroundingVerify(
  params: RunSourceGroundingVerifyParams,
): Promise<SourceGroundingVerifyResult> {
  const imageFetchFn = params.imageFetchFn ?? defaultImageFetch;
  let images: Array<{ data: string; mediaType: string }>;
  try {
    images = await imageFetchFn([params.sourceAssetId], params.db);
  } catch (err) {
    return {
      status: 'transient_error',
      message: `source grounding image fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // A stored source_asset id that resolves to no bytes is a data-integrity anomaly, not a
  // content verdict — retry (fail-closed) rather than falsely reporting「not grounded」.
  if (images.length === 0) {
    return {
      status: 'transient_error',
      message: `source grounding image unavailable for asset ${params.sourceAssetId}`,
    };
  }

  const llmTextPayload = JSON.stringify({
    prompt_md: params.prompt_md,
    reference_md: params.reference_md ?? null,
    image_present: true,
  });

  const runTaskFn = params.runTaskFn ?? defaultStructuredRunTaskFn;
  let taskResult: StructuredTaskResult;
  try {
    taskResult = await runTaskFn(
      'SourceGroundingVerifyTask',
      { text: llmTextPayload, images },
      {
        db: params.db,
        subjectProfile: params.subjectProfile,
        // Same vision provider routing as the multimodal judges; a process pin
        // suppresses the scoped lane entirely (the lane never runs under a pin).
        override: applicableVisionJudgeOverride(),
        // NO enableTransientRetry (single-transient-layer principle,): unlike
        // multimodal_direct / steps (called synchronously from the judge router, whose catch
        // swallows failures into 'unsupported' → pg-boss never sees a throw), this runner is
        // called from the DURABLE source_verify pg-boss job. On a transient error it returns
        // transient_error → source_verify fails closed (demote) AND THROWS → pg-boss
        // redelivery is the retry layer. Opting into in-process retry here would stack a
        // second layer on top of queue redelivery.
      },
    );
  } catch (err) {
    // A misconfigured or unauthenticated lane is a recoverable configuration
    // defect, not a content verdict or ordinary transient failure.
    if (err instanceof TaskConfigError || isProviderAuthConfigError(err)) {
      return { status: 'config_error', message: err.message };
    }
    return {
      status: 'transient_error',
      message: `source grounding VLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: SourceGroundingVerifyOutputT;
  try {
    parsed = parseSourceGroundingResult(taskResult);
  } catch (err) {
    return {
      status: 'transient_error',
      message: `source grounding output parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    status: parsed.grounded ? 'grounded' : 'not_grounded',
    confidence: parsed.confidence,
    observed_md: parsed.observed_md,
    reason_md: parsed.reason_md,
  };
}

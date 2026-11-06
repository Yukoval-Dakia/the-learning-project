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

import { isProviderAuthConfigError } from '@/ai/agent-run-error';
import {
  SourceGroundingVerifyOutput,
  type SourceGroundingVerifyOutputT,
} from '@/core/schema/source-grounding';
import type { Db } from '@/db/client';
import { TaskConfigError } from '@/server/ai/providers';
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
    const { preflightTaskExecution } = await import('@/server/ai/runner-preflight');
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

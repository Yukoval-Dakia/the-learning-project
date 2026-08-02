// YUK-230 (PR #1063 review, thread 2) — source-grounding verification runner.
//
// Reuses the multimodal judge INFRA (R2 image fetch + SDK structured-output dispatch,
// same shape as multimodal-direct-judge.ts / steps-judge.ts) but runs a GROUNDING-
// specific prompt (SourceGroundingVerifyTask): re-read the source image and decide
// whether the question 题面 actually appears in it. This is the fix for the threat
// model gap where feeding reference_md as a "student answer" to the answer-correctness
// judge could not catch a VLM that hallucinated a self-consistent 题面 + 答案 unrelated
// to the image.
//
// Returns a discriminated result so the caller (source_verify.ts) can distinguish:
//   - grounded / not_grounded : a real content verdict (not_grounded → demote to draft)
//   - transient_error         : image fetch / LLM call / output parse failed — NOT a
//                               content verdict. The caller fails closed (demote) AND
//                               retries (既有 verify 错误惯例). Kept OUT of the grounded
//                               vs not_grounded axis so a flaky VLM never reads as a
//                               confident「题面不在图里」.

import { tasks } from '@/ai/registry';
import {
  SourceGroundingVerifyOutput,
  type SourceGroundingVerifyOutputT,
} from '@/core/schema/source-grounding';
import type { Db } from '@/db/client';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import { visionJudgeProviderOverride } from '@/server/ai/vision-judge-config';
import type { SubjectProfile } from '@/subjects/profile';
import {
  type StructuredTaskResult,
  defaultStructuredRunTaskFn,
  parseStructuredTaskOutput,
} from './judge-output-parse';
// Reuse the steps@1 R2 image fetcher verbatim — no R2 logic duplicated here.
import { defaultImageFetch } from './steps-judge';

// Built ONCE from the registry-declared schema (the single, audited source), mirroring
// the multimodal/steps judges. A structured-output-capable endpoint constrains + SDK-
// retries the model to the schema; mimo ignores it and the dispatch falls back to the
// char-scan text parse (zero-loss).
const outputSchema = tasks.SourceGroundingVerifyTask.structuredOutputSchema;
const OUTPUT_FORMAT = outputSchema ? zodToJsonSchemaOutputFormat(outputSchema) : undefined;

// Concrete `{ text, images }` input (NOT `... | unknown`, which collapses the whole union
// to `unknown` and erases the documented shape — PR #1063 review thread 8).
export type SourceGroundingRunTaskFn = (
  kind: string,
  input: { text: string; images: Array<{ data: string; mediaType: string }> },
  ctx: unknown,
) => Promise<StructuredTaskResult>;

export type SourceGroundingImageFetchFn = (
  assetIds: string[],
  db: Db,
) => Promise<Array<{ data: string; mediaType: string }>>;

export interface RunSourceGroundingVerifyParams {
  db: Db;
  prompt_md: string;
  reference_md: string | null;
  /** The source_asset row id the question was extracted from (image_candidate accept). */
  sourceAssetId: string;
  subjectProfile: SubjectProfile;
  runTaskFn?: SourceGroundingRunTaskFn;
  imageFetchFn?: SourceGroundingImageFetchFn;
}

export type SourceGroundingVerifyResult =
  | { status: 'grounded'; confidence: number; observed_md: string; reason_md: string }
  | { status: 'not_grounded'; confidence: number; observed_md: string; reason_md: string }
  | { status: 'transient_error'; message: string };

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
        // Same vision provider routing as the multimodal judges.
        override: visionJudgeProviderOverride(),
        // NO enableTransientRetry (single-transient-layer principle, YUK-576 §3.2): unlike
        // multimodal_direct / steps (called synchronously from the judge router, whose catch
        // swallows failures into 'unsupported' → pg-boss never sees a throw), this runner is
        // called from the DURABLE source_verify pg-boss job. On a transient error it returns
        // transient_error → source_verify fails closed (demote) AND THROWS → pg-boss
        // redelivery is the retry layer. Opting into in-process retry here would stack a
        // second layer on top of queue redelivery (the exact anti-pattern the retry-optin pin
        // guards). See src/server/ai/retry-optin.test.ts.
        outputFormat: OUTPUT_FORMAT,
      },
    );
  } catch (err) {
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

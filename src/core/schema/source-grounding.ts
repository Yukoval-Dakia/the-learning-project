// YUK-230 (PR #1063 review, thread 2) — dedicated source-grounding verification
// output. This is NOT an answer-correctness judge (that is multimodal_direct); it
// answers a single question: does the question's 题面 actually appear in / derive
// from the source image it was extracted from? It exists to catch VLM hallucination
// on the image_candidate extraction path, where the extracted prompt + answer can be
// internally self-consistent yet unrelated to the image.
//
// Runtime lives in src/server/ai/judges/source-grounding-verify.ts (reuses the same
// vision task machinery — image fetch + SDK structured output — as the multimodal
// judges, but with a grounding-specific prompt/schema). The registry task is
// SourceGroundingVerifyTask (src/ai/registry.ts).

import { z } from 'zod';

export const SourceGroundingVerifyOutput = z.object({
  // true ⇔ the question 题面's core content is present in / supported by the source
  // image; false ⇔ the image is unrelated, or the 题面 looks fabricated relative to
  // the image (the hallucination signal).
  grounded: z.boolean(),
  confidence: z.number().min(0).max(1),
  // What the model actually saw in the image that is relevant to the 题面 (evidence). The
  // prompt requires it「即使图片模糊也尽量给出」, so .min(1) matches that contract — an empty
  // observed_md is a malformed output → parse fail → transient_error (PR #1063 thread 6).
  observed_md: z.string().min(1),
  // Why grounded / not grounded — cites the image evidence.
  reason_md: z.string().min(1),
});
export type SourceGroundingVerifyOutputT = z.infer<typeof SourceGroundingVerifyOutput>;

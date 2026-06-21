/**
 * ColdStartPlacementBridgeTask I/O contract — YUK-478 (cold-start upload→placement bridge).
 *
 * A single-shot, text-only structured-output AI task that runs ONCE per uploaded
 * question whose VLM extraction produced NO knowledge-graph match (the thin-seed
 * tree from YUK-477 has only subject-root nodes, so TaggingTask's anti-hallucination
 * filter drops every suggestion → knowledge_ids:[] → the question is invisible to
 * placement). This task COMBINES two cold-start bridges into ONE LLM pass (efficiency,
 * per the YUK-478 brief):
 *   ① subject classification — pick which KNOWN_SUBJECT_ID the question belongs to,
 *      so a child KC can be created under `seed:<subjectId>:root` and the question
 *      attributed to it (placement filters on `knowledge_ids @> [kc]`).
 *   ③ reference-answer generation — when OCR extracted the prompt but NOT the answer
 *      (`reference_md` null), produce a correct reference answer FOR the existing
 *      prompt so the judge (route-resolve.ts) has a real grading anchor.
 *
 * `subject_id` is validated against KNOWN_SUBJECT_IDS by the invoker
 * (src/capabilities/ingestion/server/cold-start-bridge.ts) — an out-of-vocabulary
 * value is rejected, never silently coerced.
 */
import { z } from 'zod';

// ---------- input (what the LLM receives) ----------

export const ColdStartBridgeInput = z.object({
  /** The VLM-extracted question prompt (block.extracted_prompt_md). */
  question_md: z.string().min(1),
  /**
   * The reference answer OCR already extracted, when present. When non-null the
   * LLM should ECHO it back verbatim (no regeneration); when null it must GENERATE
   * a correct reference answer for `question_md`.
   */
  existing_reference_md: z.string().nullable().default(null),
  /**
   * Soft topic hint carried from extraction (block.knowledge_hint), or null. Used
   * only to disambiguate subject + name the child KC; never authoritative.
   */
  knowledge_hint: z.string().nullable().default(null),
  /** The known subject ids the classifier MUST pick from (anti-hallucination). */
  known_subject_ids: z.array(z.string().min(1)).min(1),
});
export type ColdStartBridgeInputT = z.infer<typeof ColdStartBridgeInput>;

// ---------- output (the LLM's structured JSON) ----------

export const ColdStartBridgeOutput = z.object({
  /**
   * MUST be one of `known_subject_ids` — the invoker rejects an out-of-vocabulary
   * value rather than coercing it (a wrong subject would mis-root the child KC).
   */
  subject_id: z.string().min(1),
  /**
   * A concise (≤ 60 char) knowledge-concept name derived from the question topic,
   * used as the child KC's `name` under the subject root. NOT the question text.
   */
  kc_name: z.string().min(1).max(60),
  /**
   * The reference answer for `question_md`. Echoes `existing_reference_md` when it
   * was provided, otherwise a freshly generated correct answer. May be empty only
   * when the model genuinely cannot answer; the invoker treats empty as "no anchor".
   */
  reference_md: z.string(),
  /** Free-form rationale for the subject pick + answer (audit only). */
  reasoning: z.string().default(''),
});
export type ColdStartBridgeOutputT = z.infer<typeof ColdStartBridgeOutput>;

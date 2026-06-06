// YUK-216 S2 (题源扩展 Strategy D) — slice 2 在线检索线 (SourcingTask → tier 2).
//
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §3 / §5
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §3 + 实证 2.
//
// SourcingTask fetches EXISTING questions off the web and structures them into
// review-pool drafts (source='web_sourced', tier 2 "sourced"). Its LLM output
// shape is `SourcedQuestion` — a NEW schema modelled on QuizGenQuestion (实证 2:
// StructuredQuestion is an OCR evidence tree with bbox / handwriting / page_index
// semantics that a web-text-sourced question has none of; reusing it would drag in
// a pile of undefined optional fields — the wrong abstraction). The difference vs
// QuizGenQuestion is PROVENANCE: a sourced question carries its origin URL/title
// (WebSourcedProvenance) instead of generator source_refs.
//
// OF-1 回填 (YUK-223 issue): the first cut extracts from HTML/TEXT sources only;
// image-type sources are out of the first version.
import { z } from 'zod';
import { QuestionKind, Rubric } from './business';

// ---------- per-question LLM output shape ----------
//
// Mirrors QuizGenQuestion (kind + prompt_md + reference_md + optional choices /
// judge / rubric + difficulty + knowledge_ids) but swaps generator source_refs for
// a single source URL/title pair (the page the question was lifted + restructured
// from). judge_kind_override is constrained to exact|keyword|semantic for the SAME
// reason as QuizGenQuestion (quiz_gen.ts:132 comment): 'steps' / 'unit_dimension'
// are profile-preferred first-class routes (never a generator/sourcing override)
// and 'rubric' has no runner — allowing them would let a question enter the pool yet
// return `unsupported` the moment the learner answers.
export const SourcedQuestion = z.object({
  kind: QuestionKind,
  prompt_md: z.string().min(1),
  reference_md: z.string().min(1),
  choices_md: z.array(z.string().min(1)).max(6).nullable().optional(),
  judge_kind_override: z.enum(['exact', 'keyword', 'semantic']).nullable().optional(),
  rubric_json: Rubric.nullable().optional(),
  difficulty: z.number().int().min(1).max(5),
  knowledge_ids: z.array(z.string().min(1)),
  // The page this question was sourced from. URL + title are REQUIRED (a sourced
  // question with no origin URL has no tier-2 provenance — it would be
  // indistinguishable from a generated question). The per-question url feeds the
  // row's metadata.web_sourced + source_ref column at persist time.
  source_url: z.string().url(),
  source_title: z.string().min(1),
  // Optional fingerprint of the extracted content (dedup / audit cross-evidence).
  // Folded into metadata.web_sourced.extraction_hash by the handler.
  extraction_hash: z.string().min(1).optional(),
  // The text the agent actually lifted from source_url for THIS question (the page
  // passage the prompt + reference were restructured from). Folded into
  // metadata.web_sourced.extract so source_verify's source_consistency check can run a
  // DETERMINISTIC prompt↔source overlap WITHOUT refetching the network (mirrors the
  // quiz_gen source_pack snippet → quiz_verify maxNgramOverlap precedent). Optional:
  // absent → the verify gate keeps structural-only consistency (no overlap signal).
  extract: z.string().min(1).optional(),
});
export type SourcedQuestionT = z.infer<typeof SourcedQuestion>;

// ---------- whole-run LLM output shape ----------
//
// The SourcingTask agent emits a batch of sourced questions plus the run-level
// search plan (audit / reproducibility). The handler maps each question into a
// `question` row + metadata.web_sourced provenance and chains a tier-2 verify job.
export const SourcingTaskOutput = z.object({
  questions: z.array(SourcedQuestion).min(1).max(10),
  // The queries the agent executed (audit trail; provenance is NOT recoverable from
  // runner logs, so the agent self-reports — same §0 constraint as QuizGen).
  query_plan: z.array(z.string().min(1)),
  // ISO string (same shape as quiz_gen source_pack.searched_at — string, not Date).
  fetched_at: z.string().min(1),
  tool: z.literal('tavily'),
});
export type SourcingTaskOutputT = z.infer<typeof SourcingTaskOutput>;

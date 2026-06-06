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
// OF-1 回填 (YUK-223 issue / YUK-227 S3 Slice C): HTML/TEXT sources are extracted
// inline and INSERTed as drafts (the `questions` path below). Image-type sources —
// pages whose question stem lives in an image that tavily_extract cannot lift as
// plain text — are NOT auto-extracted (守 ADR-0002: VLM 抽图是用户授权的付费动作).
// Instead the agent reports them as `image_candidates`; the handler turns each into
// an `image_candidate` proposal (proposal inbox), and a VLM extraction runs ONLY on
// explicit user accept. See docs/superpowers/plans/2026-06-06-yuk227-s3-image-
// reachability.md §2 Slice C + §4 cost gate.
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
  // quiz_gen source_pack snippet → quiz_verify maxNgramOverlap precedent). REQUIRED
  // (F2, PR #313): without an extract the declared source_url has no deterministic
  // anchor and a fabricated URL would promote to tier 2 unchecked — source_verify
  // fails any web_sourced row lacking a non-empty extract, so the producer must supply
  // it (aligned with WebSourcedProvenance.extract being required).
  extract: z.string().min(1),
});
export type SourcedQuestionT = z.infer<typeof SourcedQuestion>;

// ---------- image-type source candidate (YUK-227 S3 Slice C) ----------
//
// A real-question source the agent located but could NOT lift as plain text because
// the question stem lives inside an image (e.g. a scanned 试卷 PNG, a 图表 题). The
// agent reports it here INSTEAD of fabricating a text question. The handler writes one
// `image_candidate` proposal per entry; the page's image is downloaded + VLM-extracted
// ONLY on explicit user accept (守 ADR-0002 — no auto VLM 抽图 path). The agent
// determines "image-type" by inference: tavily_extract returned empty/near-empty text
// for a URL that the search result indicates carries questions (Tavily's hosted MCP
// search response shape is not parsed in our code — buildTavilyMcpServer only mounts
// the remote server — so the agent, not the handler, classifies the source; see plan
// §6 F1(c) + §6.1).
export const SourcingImageCandidate = z.object({
  // The page URL whose question(s) are image-only. Required: without it there is no
  // asset to download on accept (mirrors SourcedQuestion.source_url being required).
  source_url: z.string().url(),
  source_title: z.string().min(1),
  // Why the agent judged this an image-type source + a human-readable summary of what
  // the page appears to contain (shown in the proposal inbox so the user decides
  // whether to spend a VLM extraction on accept).
  summary_md: z.string().min(1).max(4000),
});
export type SourcingImageCandidateT = z.infer<typeof SourcingImageCandidate>;

// ---------- whole-run LLM output shape ----------
//
// The SourcingTask agent emits a batch of sourced questions plus the run-level
// search plan (audit / reproducibility). The handler maps each question into a
// `question` row + metadata.web_sourced provenance and chains a tier-2 verify job.
export const SourcingTaskOutput = z
  .object({
    // YUK-227 S3 Slice C — relaxed from min(1) to min(0): a run may find ONLY
    // image-type sources (0 text questions) and still be a valid, useful result
    // (it yields image_candidate proposals). The superRefine below enforces that a
    // run produces SOMETHING (≥1 question OR ≥1 image_candidate), so an empty run
    // still fails loudly.
    questions: z.array(SourcedQuestion).max(10),
    // Image-type sources the agent located but did NOT extract (守 ADR-0002). Each
    // becomes an `image_candidate` proposal; VLM extraction runs only on user accept.
    // Optional + capped — a text-only run omits it entirely.
    image_candidates: z.array(SourcingImageCandidate).max(10).optional(),
    // The queries the agent executed (audit trail; provenance is NOT recoverable from
    // runner logs, so the agent self-reports — same §0 constraint as QuizGen).
    query_plan: z.array(z.string().min(1)),
    // ISO string (same shape as quiz_gen source_pack.searched_at — string, not Date).
    fetched_at: z.string().min(1),
    tool: z.literal('tavily'),
  })
  .superRefine((value, ctx) => {
    const questionCount = value.questions.length;
    const candidateCount = value.image_candidates?.length ?? 0;
    if (questionCount === 0 && candidateCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sourcing run produced neither questions nor image_candidates (empty result)',
      });
    }
  });
export type SourcingTaskOutputT = z.infer<typeof SourcingTaskOutput>;

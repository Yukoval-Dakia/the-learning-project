import { z } from 'zod';
import { ActivityRef } from './activity';
import {
  ConjectureDiagnosticSpec,
  ConjectureProbePackage,
  ConjectureProbeQualityAudit,
  ConjectureProbeSpec,
  QuestionKind,
  conjectureHypothesisCoreMatches,
  conjectureProbePackagesEqual,
  evaluateConjectureProbePackageStructure,
  normalizeProbeIdentity,
} from './business';
import { CauseCategory } from './cause';
import { RelationTypeSchema } from './event/blocks';
import { SuggestionKind, type SuggestionKindT } from './event/known';

export const aiProposalKinds = [
  'knowledge_node',
  'knowledge_edge',
  'knowledge_mutation',
  'learning_item',
  'note_update',
  'variant_question',
  'completion',
  'relearn',
  // Coach plan_adjustment 'defer' lane.
  'defer',
  'record_links',
  'record_promotion',
  'archive',
  'judge_retraction',
  // AI infers a goal's covered knowledge + rough ordering; user confirms via
  // the proposal inbox and accept materializes the `goal` row.
  'goal_scope',
  // AI proposes cross-page/adjacent block merges; accept reuses the
  // `mergeQuestions` primitive — no auto-merge (hard safety boundary).
  'block_merge',
  // SourcingTask located a real-question source whose stem is image-only.
  // Proposed INSTEAD of auto-extracting; VLM 抽图 runs ONLY on explicit user
  // accept (用户授权的付费动作，ADR-0002)。Accept downloads the image, runs
  // VisionExtractTask (manual_rescue_only), and produces a tier-2
  // SourcedQuestion through the existing source_verify gate.
  'image_candidate',
  // Copilot-authored draft question: the tool INSERTs the question row with
  // draft_status='draft' (invisible to pool / review / FSRS) and writes this
  // proposal in the same transaction. Accept PROMOTES draft→active +
  // FSRS-enrolls (accept = promotion, not insert).
  'question_draft',
  // A narrow, typed node edit to an ACTIVE question's `structured` tree,
  // addressing nodes by the SAME id/role coordinate system the addressable
  // projection reads (read≡write coordinate parity). Proposal-only +
  // reversible: accept re-runs a mini verify gate, applies the op via a
  // node-addressed mutation, and writes an audit event (before/after) so
  // retract can correct it — never a raw structured overwrite.
  'question_edit',
  // A first-class CONJECTURE about the learner's mind: a misconception belief
  // (claim_md) + an unrun discriminating probe + the claim's implied p̂ on that
  // probe (predicted_p) + the quantitative PFA/θ baseline it must beat
  // (baseline_p_at_induction). Has a real accept applier
  // (acceptConjectureProposal, agency package), so it is in
  // acceptSupportedProposalKinds.
  'conjecture',
  // 错因 catalog 扩张：`other` 归因复发 → LLM 提议新类目（或 owner 手动提议）→
  // owner accept → `cause_category_overlay` INSERT。词表从此不只靠发版扩张
  // （DB overlay 与 profile.causeCategories 合并读取）。
  'cause_category',
] as const;

export const AiProposalKind = z.enum(aiProposalKinds);
export type AiProposalKindT = z.infer<typeof AiProposalKind>;

// Canonical proposal-decision resource. The public vocabulary is deliberately
// smaller than the legacy route vocabulary:
//   reject / veto -> dismiss (compatibility adapters)
//   retract       -> an L3 correction event
// accept/reverse/change_type/dismiss remain immutable rate events. The
// proposal id + normalized decision is the retry identity; a same-decision
// replay returns the existing event, while a different terminal decision is a
// conflict.
export const ProposalDecision = z.enum(['accept', 'reverse', 'change_type', 'dismiss', 'retract']);
export type ProposalDecisionT = z.infer<typeof ProposalDecision>;

// Shared with the TeachingBrief inline-edit textarea's maxLength — one source of truth so
// the client cap and this server contract cannot drift.
export const CONJECTURE_CLAIM_MAX_CHARS = 280;

export const ProposalDecisionInput = z
  .object({
    decision: ProposalDecision,
    new_relation_type: RelationTypeSchema.optional(),
    user_note: z.string().max(2000).optional(),
    reason_md: z.string().trim().min(1).max(2000).optional(),
    affected_refs: z.array(ActivityRef).min(1).optional(),
    corrected_payload: z
      .object({ claim_md: z.string().trim().min(1).max(CONJECTURE_CLAIM_MAX_CHARS) })
      .strict()
      .optional(),
    // block_merge is lossy (absorbed blocks fold into the primary and cannot
    // be un-merged). Accepting one requires an explicit confirm_lossy: true;
    // the flag is accept-only and enforced at the shared accept boundary, so
    // legacy/direct callers cannot bypass it.
    confirm_lossy: z.literal(true).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.decision === 'change_type' && !data.new_relation_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'change_type requires new_relation_type',
        path: ['new_relation_type'],
      });
    }
    if (data.decision !== 'change_type' && data.new_relation_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'new_relation_type is only valid for change_type',
        path: ['new_relation_type'],
      });
    }
    if (data.decision !== 'accept' && data.corrected_payload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'corrected_payload is only valid for accept',
        path: ['corrected_payload'],
      });
    }
    if (data.decision !== 'accept' && data.confirm_lossy !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'confirm_lossy is only valid for accept',
        path: ['confirm_lossy'],
      });
    }
    if (data.decision !== 'retract' && (data.reason_md || data.affected_refs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reason_md and affected_refs are only valid for retract',
        path: ['decision'],
      });
    }
    if (data.decision === 'retract' && data.user_note) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'user_note is not valid for retract; use reason_md',
        path: ['user_note'],
      });
    }
  });
export type ProposalDecisionInputT = z.infer<typeof ProposalDecisionInput>;

// The decision resource is an explicit union, not a broadly nullable success
// contract: every COMMITTED decision still requires its immutable event id
// (readable through GET /api/events/:id, so the HTTP handler can return an
// honest Location). Exactly ONE narrow member carries decision_event_id:null —
// the block_merge soft-stale accept, where nothing was decided (the merge was
// skipped: no rate event, no decision signal, no status change), so there is
// no event to point at. The union keeps that null hole typed to this single
// member, and the route serves it 200 non-created with no Location header.
const ProposalDecisionResourceCommitted = z.object({
  proposal_id: z.string().min(1),
  proposal_kind: AiProposalKind,
  decision: ProposalDecision,
  decision_event_id: z.string().min(1),
  proposal_status: z.enum(['pending', 'accepted', 'dismissed', 'stale', 'rubric_rejected']),
  created: z.boolean(),
  idempotent: z.boolean(),
  result: z.unknown().nullable().optional(),
});

// The soft-stale member: an accept of a block_merge proposal whose referenced
// blocks left draft before the merge ran (applier returned {stale:true}). The
// proposal stays pending — no false resolve — and the UI reads result.stale to
// show the stale notice instead of treating the card as accepted.
export const ProposalDecisionResource = z.union([
  ProposalDecisionResourceCommitted,
  ProposalDecisionResourceCommitted.extend({
    decision: z.literal('accept'),
    proposal_kind: z.literal('block_merge'),
    decision_event_id: z.null(),
    proposal_status: z.literal('pending'),
    created: z.literal(false),
    idempotent: z.literal(false),
  }),
]);
export type ProposalDecisionResourceT = z.infer<typeof ProposalDecisionResource>;

// dispatchAccept（src/server/proposals/actions.ts）为这些 kind 实现了 accept
// applier；只有 defer / archive 走 default 分支抛 unsupported_proposal_kind
// 400。UI（ProposalCard）据此门控 Accept CTA；增删 accept kind 时保持
// 「本集合 ∪ 未实现 kind === aiProposalKinds」不漂移。judge_retraction 的
// 接受面在 practice proposal-appliers（判分纠错走 appeal/rejudge/CAS 激活 +
// settlement replay；legacy judge-event → CorrectEvent）。
export const acceptSupportedProposalKinds = [
  'knowledge_node',
  'knowledge_edge',
  'knowledge_mutation',
  'learning_item',
  'note_update',
  'variant_question',
  'completion',
  'relearn',
  'record_links',
  'record_promotion',
  'goal_scope',
  'block_merge',
  'image_candidate',
  'question_draft',
  // Active-question structured node edit.
  'question_edit',
  // Conjecture accept/edit/reject applier (acceptConjectureProposal).
  // accept = calibration anchor (NOT confirmed); edit → mem0 CORE; reject →
  // digest. Never writes FSRS (ND-5).
  'conjecture',
  // cause_category_overlay 写路径 = accept applier（audit:schema 要求的唯一
  // INSERT 边界）。
  'cause_category',
  // 判分纠错提案（evaluation 目标走 appeal/rejudge/CAS 激活链；legacy
  // judge-event 目标写 CorrectEvent）。人审 accept，不自动执行。
  'judge_retraction',
] as const satisfies readonly AiProposalKindT[];

// ───────────────────────────────────────────────────────────────────────────
// 出手强度轴（ADR-0039 A 档 strength tier）— 与 accept-applier 轴
// (acceptSupportedProposalKinds) 正交的第三轴。三档语义：
//   A — reserved auto-apply tier. No proposal kind currently uses it: destructive
//       lifecycle changes require an explicit user decision.
//   B — propose（pending 入收件箱，人审 accept）。默认档，绝大多数 kind 在此。
//   C — observe-only（仅折叠到 AI 观察面，无 Accept CTA）。恰好是「无 accept
//       applier」的三 kind：dispatchAccept 对它们抛 unsupported_proposal_kind。
//
// 红线（防双 SoT 漂移）：C 档集合 ⟺
// `aiProposalKinds ∖ acceptSupportedProposalKinds`（当前 = {defer, archive}）
// 恒等。强度轴 ≠ accept-applier 轴 ≠ tone 视觉轴（KIND_META.tone），三轴勿耦合。
export type AiProposalStrength = 'A' | 'B' | 'C';

export const aiProposalKindStrength = {
  // Completion changes learning-item lifecycle state, so it stays human-reviewed.
  completion: 'B',
  // C — observe-only（恒 ⟺ aiProposalKinds ∖ acceptSupportedProposalKinds）。
  defer: 'C',
  archive: 'C',
  // 判分纠错：人审 accept 才生效（B 档），绝不自动执行。
  judge_retraction: 'B',
  // B — propose（默认档）。
  knowledge_node: 'B',
  knowledge_edge: 'B',
  knowledge_mutation: 'B',
  learning_item: 'B',
  // note_update 是下一个 A 候选（小可逆笔记编辑；mutator 侧已验证 auto-apply +
  // 撤销窗口，proposal 侧仍 B，待 owner 翻档）。
  note_update: 'B',
  variant_question: 'B',
  relearn: 'B',
  // LEGACY tombstone —— accept applier 仍在但 producer 早停写，永不 surface 到
  // 收件箱。归 B 仅为穷举完整，实际不渲染。
  record_links: 'B',
  record_promotion: 'B',
  goal_scope: 'B',
  block_merge: 'B',
  image_candidate: 'B',
  question_draft: 'B',
  question_edit: 'B',
  conjecture: 'B',
  // catalog 扩张永远过人审（词表是归因合同的一部分）。
  cause_category: 'B',
} as const satisfies Record<AiProposalKindT, AiProposalStrength>;

export function kindStrength(kind: AiProposalKindT): AiProposalStrength {
  return aiProposalKindStrength[kind];
}

export const ProposalEvidenceRef = z.object({
  kind: z.enum(['event', 'question', 'knowledge', 'artifact', 'record']),
  id: z.string().min(1),
  // kind='event' 的可选 action 角色细分：tally 证据里 user_cause 与 judge
  // event 混排，不带 role 时 reviewer 得回查 event 行才能分辨。
  event_role: z.enum(['judge', 'user_cause']).optional(),
});
export type ProposalEvidenceRefT = z.infer<typeof ProposalEvidenceRef>;

export const ProposalTarget = z.object({
  subject_kind: z.string().min(1),
  subject_id: z.string().min(1).nullable(),
});
export type ProposalTargetT = z.infer<typeof ProposalTarget>;

const NonEmptyObject = z
  .record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length > 0, {
    message: 'proposed_change must not be empty',
  });

const BaseProposal = z.object({
  target: ProposalTarget,
  reason_md: z.string().min(1).max(4000),
  evidence_refs: z.array(ProposalEvidenceRef).default([]),
  rollback_plan: z.unknown().optional(),
  cooldown_key: z.string().min(1).max(300).optional(),
  // Proactive (default, absence) vs corrective discriminator. OPTIONAL on
  // every kind via the union; absence === 'proactive' (see
  // resolveSuggestionKind). Set deterministically only by the
  // variant_question producer (the one structurally-corrective kind) and by
  // explicit model labeling via the 4 propose tools' optional input arg.
  // Changes ONLY KPI attribution (corrective is excluded from the
  // accept-learned signal), never proposal accept/reject side-effects.
  suggestion_kind: SuggestionKind.optional(),
});

export const KnowledgeNodeProposalChange = z.object({
  mutation: z.literal('propose_new'),
  name: z.string().min(1).max(120),
  // null = propose a NEW subject/domain ROOT (requires `domain`); a string id =
  // propose a child under that existing node (domain inherited, omit `domain`).
  parent_id: z.string().min(1).nullable(),
  // Domain the root anchors (e.g. 'english'). Required iff parent_id is null —
  // enforced at the tool/accept layer, optional here so legacy child payloads
  // parse unchanged.
  domain: z.string().min(1).optional(),
});
export type KnowledgeNodeProposalChangeT = z.infer<typeof KnowledgeNodeProposalChange>;

// Edge proposal discriminator. `edge_op` distinguishes CREATE (the
// pre-existing default: propose a new mesh edge) from ARCHIVE (soft-delete a
// live edge — set archived_at via the accept applier, never a hard delete) and
// SUPERSEDE (preserve a reconcile replacement recommendation until an explicit
// user accept). It is an ADDITIVE marker with `.default('create')`, so every
// payload written before this field parses byte-identically to the prior
// create shape. `from/to/relation_type` stay required on BOTH ops: for archive
// they NAME the edge the proposal targets (inbox card render + rubric
// structural checks read them), while `archive_edge_id` is the authoritative
// id the applier flips. The discriminator lives on the proposed_change rather
// than a separate proposal kind to keep the knowledge_edge kind (and its
// inbox/writer/dispatch wiring) single.
export const KnowledgeEdgeProposalChange = z.object({
  edge_op: z.enum(['create', 'archive', 'supersede']).default('create'),
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: RelationTypeSchema,
  weight: z.number().min(0).max(1).default(1),
  // Authoritative target for edge_op==='archive': the live knowledge_edge.id
  // to soft-delete. Optional on the shape so create payloads omit it; the
  // archive PROPOSE path requires it (enforced at the tool executor, not the
  // schema, so the create branch's parse stays untouched).
  archive_edge_id: z.string().min(1).optional(),
  // A reconcile SUPERSEDE is still an edge proposal: the model may recommend
  // replacing a live edge, but only an explicit user accept applies the
  // archive + replacement transaction. These fields preserve the judged
  // decision until that accept boundary.
  supersede_confidence: z.number().min(0).max(1).optional(),
  supersede_neighbor_index: z.number().int().min(0).nullable().optional(),
  supersede_affected_refs: z.array(ActivityRef).min(1).optional(),
});
export type KnowledgeEdgeProposalChangeT = z.infer<typeof KnowledgeEdgeProposalChange>;

export const KnowledgeMutationProposalChange = z.discriminatedUnion('mutation', [
  z.object({
    mutation: z.literal('reparent'),
    node_id: z.string().min(1),
    new_parent_id: z.string().min(1).nullable(),
    expected_version: z.number().int().min(0),
  }),
  z.object({
    mutation: z.literal('merge'),
    from_ids: z.array(z.string().min(1)).min(1),
    into_id: z.string().min(1),
    expected_versions: z.record(z.string(), z.number().int().min(0)),
  }),
  z.object({
    mutation: z.literal('split'),
    from_id: z.string().min(1),
    into: z
      .array(
        z.object({ name: z.string().min(1).max(120), parent_id: z.string().min(1).nullable() }),
      )
      .min(1),
    expected_version: z.number().int().min(0),
  }),
]);
export type KnowledgeMutationProposalChangeT = z.infer<typeof KnowledgeMutationProposalChange>;

// goal_scope proposed_change. `scope_knowledge_ids` are the AI-inferred +
// user-confirmable nodes the goal covers; `sequence_hint` is AI-internal
// ordering (NOT a progress metric, ND-4). The user can edit any of these
// before accepting — accept materializes the goal row.
export const GoalScopeProposalChange = z.object({
  title: z.string().min(1).max(280),
  // nullable / optional — cross-subject goals allowed (ND-1).
  subject_id: z.string().min(1).nullable().optional(),
  scope_knowledge_ids: z.array(z.string().min(1)).default([]),
  sequence_hint: z.number().int().min(0).default(0),
  reasoning: z.string().min(1).max(4000),
});
export type GoalScopeProposalChangeT = z.infer<typeof GoalScopeProposalChange>;

// block_merge proposed_change. `primary_block_id` keeps its structured tree;
// `merge_block_ids` fold into it (min 1). `ingestion_session_id` scopes the
// merge (mergeQuestions is same-session only). `continuity_signal` is the AI's
// semantic-only cue (spatial/bbox page-edge detection is deferred — the task
// gains a spatial input later with no rework); optional because low-signal
// candidates can still propose. Acceptance reuses the `mergeQuestions`
// primitive.
export const BlockMergeProposalChange = z.object({
  primary_block_id: z.string().min(1),
  merge_block_ids: z.array(z.string().min(1)).min(1),
  ingestion_session_id: z.string().min(1),
  continuity_signal: z
    .enum(['page_edge', 'numbering', 'stem_answer_split', 'carryover'])
    .optional(),
  // The AI's 0..1 confidence in this merge candidate. The model's confidence
  // is not recoverable after the run, so it must be persisted at propose time
  // even before the inbox displays it.
  confidence: z.number().min(0).max(1).optional(),
});
export type BlockMergeProposalChangeT = z.infer<typeof BlockMergeProposalChange>;

// image_candidate proposed_change. The page URL + title + the agent's summary
// of why it judged the source image-type. NO image bytes here: the bytes are
// downloaded from `source_url` only on accept (the accept handler is the
// single VLM 抽图 trigger — there is no auto path). Mirrors the
// SourcingImageCandidate output shape (sourcing.ts).
export const ImageCandidateProposalChange = z.object({
  source_url: z.string().url(),
  source_title: z.string().min(1),
  summary_md: z.string().min(1).max(4000),
  // The knowledge_ids the sourcing run already resolved for this candidate.
  // Carried at propose time so the accept handler can attribute the
  // materialized question WITHOUT re-resolving — the text path stamps these on
  // question.knowledge_ids, so the image path must too or the materialized
  // question is orphaned (unattributable to the originating 知识点).
  // Defaulted: a legacy proposal (or a run that resolved no node) parses to []
  // and the accept handler inserts an empty attribution exactly as before.
  knowledge_ids: z.array(z.string().min(1)).default([]),
  // The 题型约束 the sourcing run was pinned to (if any). Image candidates
  // carry no per-question kind at propose time (the stem is unread until
  // accept's VLM), so the run-level requested kind is stamped here and the
  // accept handler normalizes it through the single-authority question-kind
  // vocabulary (src/subjects/question-kind.ts) to set question.kind.
  // Free-string + validated/normalized at accept time (an unrecognised value
  // falls back to short_answer), not here, so the proposal write stays tolerant.
  requested_kind: z.string().min(1).optional(),
});
export type ImageCandidateProposalChangeT = z.infer<typeof ImageCandidateProposalChange>;

// question_draft proposed_change. `question_id` is the ALREADY-INSERTED draft
// row (written in the same tx as this proposal); the rest is a display/audit
// snapshot so the inbox card can render without a question join. Accept reads
// `question_id` and promotes draft→active + FSRS-enrolls.
export const QuestionDraftProposalChange = z.object({
  question_id: z.string().min(1),
  kind: QuestionKind,
  difficulty: z.number().int().min(1).max(5),
  knowledge_ids: z.array(z.string().min(1)),
  seed_mode: z.enum(['knowledge', 'material']),
  // Short prompt excerpt for the inbox card (display-only; the question row is
  // the source of truth).
  prompt_preview: z.string().optional(),
  // material seed provenance (display/audit only — the material body itself is
  // NOT carried here; it fed the generation prompt and is not persisted).
  material_url: z.string().optional(),
});
export type QuestionDraftProposalChangeT = z.infer<typeof QuestionDraftProposalChange>;

// question_edit proposed_change. The edit is a NARROW, typed node operation
// (NOT an arbitrary JSON patch): one op per proposal, addressing a node by its
// `node_id` in the active question's `structured` tree (the same id/role
// coordinate the addressable projection exposes). Each op is intentionally
// scoped to a single structured-node field so the accept-side verify gate can
// re-derive the resulting tree and re-validate the StructuredQuestion
// invariants before persisting.
export const QuestionEditOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('edit_node_text'),
    node_id: z.string().min(1),
    prompt_text: z.string().min(1),
  }),
  z.object({
    op: z.literal('edit_reference'),
    node_id: z.string().min(1),
    // Both optional individually, but the tool/applier require at least one to
    // be present (an edit must change something). answers replaces the full list.
    answers: z.array(z.string()).optional(),
    analysis: z.string().optional(),
  }),
  z.object({
    op: z.literal('set_choice'),
    node_id: z.string().min(1),
    options: z.array(z.object({ label: z.string().min(1), text: z.string() })).min(1),
  }),
  z.object({
    op: z.literal('set_node_kind'),
    node_id: z.string().min(1),
    kind: QuestionKind,
  }),
]);
export type QuestionEditOpT = z.infer<typeof QuestionEditOp>;

export const QuestionEditProposalChange = z.object({
  // Legacy 提案必带；新文档提案（document create）落 edit_request 时可为空。
  question_id: z.string().min(1).optional(),
  // Legacy narrow op（旧 propose_question_edit 形状；新提案走 edit_request）。
  edit: QuestionEditOp.optional(),
  // Display-only excerpt for the inbox card (accept re-reads the live tree,
  // never trusts this snapshot).
  node_preview: z.string().optional(),
  // 统一 edit_question 契约提案（新路径优先于窄 edit）：
  // {ops?, document?, draft_ref?, expected_revision?, expected_draft_version?}。
  // accept 时经同一 draft ops → submit gate 管线回放。
  edit_request: z
    .object({
      question_id: z.string().optional(),
      ops: z.array(z.record(z.string(), z.unknown())).optional(),
      document: z.unknown().optional(),
      draft_ref: z.string().optional(),
      expected_revision: z.string().nullable().optional(),
      expected_draft_version: z.number().int().optional(),
    })
    .optional(),
});
export type QuestionEditProposalChangeT = z.infer<typeof QuestionEditProposalChange>;

// conjecture proposed_change. A first-class belief about the learner's mind,
// induced from a recurring (cause_category × KC) failure cell. The conjecture
// IS the qualitative claim AND its falsifiable prediction: `predicted_p` is
// the claim's implied P(owner answers the probe correctly), and
// `baseline_p_at_induction` snapshots the quantitative PFA/θ p(L) the claim
// must beat (scored later by scorePrediction). `confidence` is internal
// ranking/calibration only — the read model strips it and it is NEVER rendered
// as a number (anti-false-precision). `discriminating` asserts the probe is
// one only THIS misconception produces a wrong answer to — a hard precondition
// (with recurrence_count ≥ 2) for the typed-ledger writing `confused-with-X`,
// so a single off-target failure cannot flip the ledger to a misconception
// state.
export const ConjectureProposalChange = z
  .object({
    claim_md: z.string().trim().min(1).max(CONJECTURE_CLAIM_MAX_CHARS),
    knowledge_id: z.string().min(1),
    cause_category: CauseCategory,
    confidence: z.number().min(0).max(1),
    recurrence_count: z.number().int().min(2),
    // Keep the historical v1/v2 outer cap at 2000 so terminal rows stay readable.
    // New v3 producers are further constrained to 1000 by nested ConjectureProbeSpec.
    probe_md: z.string().trim().min(1).max(2000),
    // Judge gold reference. The 2000 cap matches current v3 producer output and the
    // historical payload contract.
    probe_reference_md: z.string().trim().min(1).max(2000),
    // Optional only for historical payload compatibility. Every v2 producer
    // writes both fields; a well-formed old proposal keeps its terminal v1
    // answer rule instead of inventing a follow-up or stranding an active probe.
    followup_probe_md: z.string().trim().min(1).max(2000).optional(),
    followup_probe_reference_md: z.string().trim().min(1).max(2000).optional(),
    // Optional only so historical v1/v2 proposal JSON remains readable. Every
    // new automatic producer writes the complete trio, and the accept path
    // fails closed for a newly-created proposal without it.
    diagnostic_spec: ConjectureDiagnosticSpec.optional(),
    probe_spec: ConjectureProbeSpec.optional(),
    followup_probe_spec: ConjectureProbeSpec.optional(),
    probe_quality: ConjectureProbeQualityAudit.optional(),
    discriminating: z.boolean(),
    corrected_by_owner: z.boolean().default(false),
    predicted_p: z.number().min(0).max(1),
    baseline_p_at_induction: z.number().min(0).max(1),
  })
  .superRefine((change, ctx) => {
    const hasPrompt = change.followup_probe_md !== undefined;
    const hasReference = change.followup_probe_reference_md !== undefined;
    if (hasPrompt !== hasReference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasPrompt ? ['followup_probe_reference_md'] : ['followup_probe_md'],
        message: 'follow-up probe prompt and reference must be provided together',
      });
    }
    const qualityFields = [
      change.diagnostic_spec,
      change.probe_spec,
      change.followup_probe_spec,
      change.probe_quality,
    ];
    const qualityFieldCount = qualityFields.filter((value) => value !== undefined).length;
    if (qualityFieldCount !== 0 && qualityFieldCount !== qualityFields.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['probe_quality'],
        message: 'diagnostic spec, both probe specs, and quality audit must be provided together',
      });
    }
    if (
      change.probe_spec !== undefined &&
      (change.probe_spec.prompt_md !== change.probe_md ||
        change.probe_spec.reference_md !== change.probe_reference_md)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['probe_spec'],
        message: 'probe_spec must describe the persisted primary prompt/reference',
      });
    }
    if (
      change.followup_probe_spec !== undefined &&
      (change.followup_probe_spec.prompt_md !== change.followup_probe_md ||
        change.followup_probe_spec.reference_md !== change.followup_probe_reference_md)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['followup_probe_spec'],
        message: 'followup_probe_spec must describe the persisted follow-up prompt/reference',
      });
    }
    if (change.probe_spec !== undefined && change.followup_probe_spec !== undefined) {
      const persistedPackage = {
        primary: change.probe_spec,
        followup: change.followup_probe_spec,
        predicted_p: change.predicted_p,
      };
      const coherentPackage = ConjectureProbePackage.safeParse(persistedPackage);
      if (!coherentPackage.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['probe_spec'],
          message: 'primary and follow-up probe specs must use one coherent schema version',
        });
      } else {
        for (const failureCode of evaluateConjectureProbePackageStructure(coherentPackage.data)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['probe_spec'],
            message: `probe package failed structural quality gate: ${failureCode}`,
          });
        }
      }
      if (
        change.probe_quality !== undefined &&
        'reviewed_hypothesis' in change.probe_quality &&
        change.diagnostic_spec !== undefined &&
        !conjectureHypothesisCoreMatches(change.probe_quality.reviewed_hypothesis, {
          claim_md: change.claim_md,
          knowledge_id: change.knowledge_id,
          diagnostic_spec: change.diagnostic_spec,
          cause_category: change.cause_category,
          recurrence_count: change.recurrence_count,
        })
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['probe_quality', 'reviewed_hypothesis'],
          message: 'probe_quality must be bound to the persisted frozen hypothesis',
        });
      }
      if (
        change.probe_quality !== undefined &&
        'reviewed_package' in change.probe_quality &&
        coherentPackage.success &&
        !conjectureProbePackagesEqual(change.probe_quality.reviewed_package, coherentPackage.data)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['probe_quality', 'reviewed_package'],
          message: 'probe_quality must be bound to the persisted probe package',
        });
      }
    }
    if (
      change.followup_probe_md !== undefined &&
      normalizeProbeIdentity(change.followup_probe_md) === normalizeProbeIdentity(change.probe_md)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['followup_probe_md'],
        message: 'followup_probe_md must be distinct from probe_md',
      });
    }
  });
export type ConjectureProposalChangeT = z.infer<typeof ConjectureProposalChange>;

// 新错因类目的收编载荷。`category_id` 必须走 `ov_<slug>` 命名空间（生产者负责
// 生成，applier 只做 Zod 校验 + 防撞检查）；`source` 区分 LLM 复发提议与 owner
// 手动提议，两条路径共用同一 accept 落点。
export const CauseCategoryProposalChange = z.object({
  category_id: CauseCategory,
  label: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(500).optional(),
  source: z.enum(['owner', 'llm_propose']),
});
export type CauseCategoryProposalChangeT = z.infer<typeof CauseCategoryProposalChange>;

export const AiProposalPayload = z.discriminatedUnion('kind', [
  BaseProposal.extend({
    kind: z.literal('knowledge_node'),
    target: ProposalTarget.extend({ subject_kind: z.literal('knowledge') }),
    proposed_change: KnowledgeNodeProposalChange,
  }),
  BaseProposal.extend({
    kind: z.literal('knowledge_edge'),
    target: ProposalTarget.extend({ subject_kind: z.literal('knowledge_edge') }),
    proposed_change: KnowledgeEdgeProposalChange,
  }),
  BaseProposal.extend({
    kind: z.literal('knowledge_mutation'),
    target: ProposalTarget.extend({ subject_kind: z.literal('knowledge') }),
    proposed_change: KnowledgeMutationProposalChange,
  }),
  BaseProposal.extend({
    kind: z.literal('learning_item'),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('note_update'),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('variant_question'),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('completion'),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('relearn'),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('defer'),
    target: ProposalTarget.extend({ subject_kind: z.literal('learning_item') }),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('record_links'),
    target: ProposalTarget.extend({ subject_kind: z.literal('record') }),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('record_promotion'),
    target: ProposalTarget.extend({ subject_kind: z.literal('record') }),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('archive'),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('judge_retraction'),
    proposed_change: NonEmptyObject,
  }),
  BaseProposal.extend({
    kind: z.literal('goal_scope'),
    target: ProposalTarget.extend({ subject_kind: z.literal('goal') }),
    proposed_change: GoalScopeProposalChange,
  }),
  // YUK-202 / BlockAssembly path-B — 见 BlockMergeProposalChange。
  BaseProposal.extend({
    kind: z.literal('block_merge'),
    target: ProposalTarget.extend({ subject_kind: z.literal('question_block') }),
    proposed_change: BlockMergeProposalChange,
  }),
  // image_candidate: target.subject_kind is 'source_asset' (the materialized
  // asset the accept handler will create); the subject_id is null at propose
  // time (the asset does not exist until accept).
  BaseProposal.extend({
    kind: z.literal('image_candidate'),
    target: ProposalTarget.extend({ subject_kind: z.literal('source_asset') }),
    proposed_change: ImageCandidateProposalChange,
  }),
  // question_draft: target is the already-inserted draft question row
  // (subject_id = question id, known at propose time — contrast image_candidate
  // whose asset is minted on accept).
  BaseProposal.extend({
    kind: z.literal('question_draft'),
    target: ProposalTarget.extend({ subject_kind: z.literal('question') }),
    proposed_change: QuestionDraftProposalChange,
  }),
  // question_edit: target is the live active question row. Accept applies the
  // narrow op to question.structured (practice package applier) behind a mini
  // verify gate; reversible via the audit event.
  BaseProposal.extend({
    kind: z.literal('question_edit'),
    target: ProposalTarget.extend({ subject_kind: z.literal('question') }),
    proposed_change: QuestionEditProposalChange,
  }),
  // conjecture: target subject_kind 'mind_model' with subject_id = the
  // knowledge_id the belief is about (the conjecture is not an edit to any
  // persisted row — it is a hypothesis-as-event). accept/edit/reject are
  // handled by acceptConjectureProposal (agency package).
  BaseProposal.extend({
    kind: z.literal('conjecture'),
    target: ProposalTarget.extend({ subject_kind: z.literal('mind_model') }),
    proposed_change: ConjectureProposalChange,
  }),
  // cause_category: target.subject_kind = 'subject_profile'、subject_id = 目标
  // 科目 profile.id（被扩张的是该 profile 的词表视图）；category_id 本体在
  // proposed_change（收编后 = overlay 行 id）。
  BaseProposal.extend({
    kind: z.literal('cause_category'),
    target: ProposalTarget.extend({ subject_kind: z.literal('subject_profile') }),
    proposed_change: CauseCategoryProposalChange,
  }),
]);
export type AiProposalPayloadT = z.infer<typeof AiProposalPayload>;
export type AiProposalPayloadInputT = z.input<typeof AiProposalPayload>;

export function parseAiProposalPayload(input: unknown): AiProposalPayloadT {
  return AiProposalPayload.parse(input);
}

// absence === 'proactive'. The single reader helper so the
// default-to-proactive rule lives in one place; the KPI gate (signals.ts) and
// any future reader resolve the kind through this. A corrective proposal must
// have explicitly set the field at emit (producer hard-set for
// variant_question, or model-labeled via the propose-tool arg).
export function resolveSuggestionKind(payload: {
  suggestion_kind?: SuggestionKindT;
}): SuggestionKindT {
  return payload.suggestion_kind ?? 'proactive';
}

import { z } from 'zod';
import { QuestionKind } from './business';
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
  // T-D6/C (YUK-120) — Coach plan_adjustment 'defer' lane.
  'defer',
  'record_links',
  'record_promotion',
  'archive',
  'judge_retraction',
  // YUK-143 / ADR-0025 — North-Star: AI infers a goal's covered knowledge +
  // rough ordering; user confirms via the proposal inbox (accept materializes
  // the `goal` row). Surfaces through the existing `experimental:proposal`
  // event path (writeAiProposal default) + inbox derive — no inbox.ts change.
  'goal_scope',
  // YUK-202 / BlockAssembly path-B (design 2026-06-02 §1) — AI proposes
  // cross-page/adjacent block merges; the user accepts in the inbox, which
  // reuses the YUK-195 `mergeQuestions` primitive (no auto-merge — hard safety
  // boundary). Flows through the existing experimental:proposal event/inbox
  // path (writeAiProposal default + proposalWhere); no writer/inbox change.
  'block_merge',
  // YUK-227 S3 Slice C (题源扩展 Strategy D / ADR-0002) — SourcingTask located a
  // real-question source whose stem is image-only (tavily_extract could not lift it
  // as text). The handler proposes it INSTEAD of auto-extracting; VLM 抽图 runs ONLY
  // on explicit user accept (守 ADR-0002 — VLM 抽图是用户授权的付费动作). Accept
  // downloads the image, runs VisionExtractTask (manual_rescue_only), and produces a
  // tier-2 SourcedQuestion through the existing source_verify gate. Flows through the
  // existing experimental:proposal event/inbox path (writeAiProposal default +
  // proposalWhere); accept is dispatched in src/server/proposals/actions.ts. See
  // docs/superpowers/plans/2026-06-06-yuk227-s3-image-reachability.md §2 Slice C + §4.
  'image_candidate',
  // ADR-0031 / YUK-304 (quiz C→A, lane B) — copilot-authored draft question. The
  // author_question knowledge|material seed INSERTs the question row with
  // draft_status='draft' (non-destructive: invisible to pool / review / FSRS —
  // same Option-B gate as QuizGen drafts) and writes THIS proposal in the same
  // transaction. Accept (acceptQuestionDraftProposal in
  // src/server/proposals/actions.ts) PROMOTES draft→active + FSRS-enrolls
  // (决定5: accept = promotion, not insert). Flows through the existing
  // experimental:proposal event/inbox path (writeAiProposal default +
  // proposalWhere); no writer/inbox change.
  'question_draft',
  // ADR-0032 D6-B (YUK-203 lane L6) — propose a narrow, typed node edit to an
  // ACTIVE (draft_status='active', pooled) question's `structured` tree. The
  // propose_question_edit tool addresses nodes by the SAME id/role coordinate
  // system the L5 addressable projection reads (get_question_context
  // include:['structure']) — read≡write coordinate parity. Proposal-only +
  // reversible: accept (acceptQuestionEditProposal in the practice package)
  // re-runs a mini verify gate, then applies the op to question.structured via
  // a node-addressed mutation, bumps version, and writes an
  // experimental:question_structure_edit audit event (before/after) so retract
  // can correct it — never a raw structured overwrite. Flows through the
  // existing experimental:proposal event/inbox path (writeAiProposal default +
  // proposalWhere); no writer/inbox change.
  'question_edit',
  // YUK-440 / YUK-406 (教研团 Phase 0 conjecture 引擎) — A13 prediction-grounding.
  // The nightly research-meeting job induces a first-class CONJECTURE about the
  // learner's mind: a misconception belief (claim_md) + an unrun discriminating
  // probe + the claim's implied p̂ on that probe (predicted_p) + the quantitative
  // PFA/θ baseline it must beat (baseline_p_at_induction). HAS a real accept
  // applier (acceptConjectureProposal, agency package): accept/edit/reject +
  // idempotency, so it is in acceptSupportedProposalKinds. Flows through the
  // existing experimental:proposal event/inbox path (writeAiProposal default +
  // proposalWhere); no writer/inbox change. See
  // docs/design/2026-06-27-a13-ts-half-design.md.
  'conjecture',
] as const;

export const AiProposalKind = z.enum(aiProposalKinds);
export type AiProposalKindT = z.infer<typeof AiProposalKind>;

// M4 review fix (YUK-319, codex P2) — dispatchAccept（src/server/proposals/
// actions.ts）为这 15 个 kind 实现了 accept applier；只有 defer / archive /
// judge_retraction 走 default 分支抛 unsupported_proposal_kind 400（producer/accept
// 语义归 YUK-44）。Phase 0 关系脑 (YUK-406/YUK-440) 的 conjecture 现有真身 accept
// applier（acceptConjectureProposal，agency 包），故已纳入本集合。UI（ProposalCard）
// 据此门控 Accept CTA；inbox-meta.unit.test.ts 钉住「本集合 ∪ 未实现三 kind ===
// aiProposalKinds」，dispatchAccept 增删 kind 时漂移会被测试拦下。
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
  // ADR-0032 D6-B (YUK-203 lane L6) — active-question structured node edit.
  'question_edit',
  // Phase 0 关系脑 (YUK-406 / YUK-440) — conjecture accept/edit/reject applier
  // (acceptConjectureProposal). accept = calibration anchor (NOT confirmed);
  // edit → mem0 CORE; reject → digest. Never writes FSRS (ND-5).
  'conjecture',
] as const satisfies readonly AiProposalKindT[];

export const ProposalEvidenceRef = z.object({
  kind: z.enum(['event', 'question', 'knowledge', 'artifact', 'record']),
  id: z.string().min(1),
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
  // P5.6 / YUK-178 (ADR-0011 v2 §2.1) — proactive (default, absence) vs corrective
  // discriminator. OPTIONAL on every kind via the union; absence === 'proactive'
  // (ND-SK-1, see resolveSuggestionKind). Set deterministically only by the
  // variant_question producer (the one structurally-corrective kind, SK-3) and by
  // explicit model labeling via the 4 propose tools' optional input arg (§4.1/§4.2).
  // It changes ONLY KPI attribution (corrective is excluded from the
  // accept-learned signal, §5.1), never proposal accept/reject side-effects
  // (ND-SK-2). No migration — payload field on the existing experimental:proposal
  // event.
  suggestion_kind: SuggestionKind.optional(),
});

export const KnowledgeNodeProposalChange = z.object({
  mutation: z.literal('propose_new'),
  name: z.string().min(1).max(120),
  parent_id: z.string().min(1),
});
export type KnowledgeNodeProposalChangeT = z.infer<typeof KnowledgeNodeProposalChange>;

// ADR-0032 D4-E1 (YUK-203) — edge proposal discriminator. `edge_op` distinguishes
// CREATE (the pre-existing default: propose a new mesh edge) from ARCHIVE (soft-delete
// a live edge — set archived_at via the accept applier, never a hard delete;守
// 「写入仅 propose + correction 可回滚」不变量). It is an ADDITIVE marker with
// `.default('create')`, so every payload written before this field (the nightly
// batch path, all create-branch tool callers, every persisted proposal event)
// parses byte-identically to the prior create shape — backward compatibility is
// preserved by construction. `from/to/relation_type` stay required on BOTH ops:
// for archive they NAME the edge the proposal targets (inbox card render + rubric
// structural checks read them), while `archive_edge_id` is the authoritative id
// the applier flips. The node omnibus (propose_knowledge_mutation: propose_new …
// archive) is the discriminator precedent; here the discriminator lives on the
// proposed_change rather than a separate proposal kind to keep the knowledge_edge
// kind (and its inbox/writer/dispatch wiring) single — only one new branch.
export const KnowledgeEdgeProposalChange = z.object({
  // 'create' (default / absence) = propose a new edge; 'archive' = soft-delete the
  // live edge named by archive_edge_id. Defaulted so legacy/create payloads are
  // unchanged.
  edge_op: z.enum(['create', 'archive']).default('create'),
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: RelationTypeSchema,
  weight: z.number().min(0).max(1).default(1),
  // Authoritative target for edge_op==='archive': the live knowledge_edge.id to
  // soft-delete. Optional on the shape so create payloads omit it; the archive
  // PROPOSE path requires it (enforced at the tool executor, not the schema, so
  // the create branch's parse stays untouched).
  archive_edge_id: z.string().min(1).optional(),
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

// YUK-143 / ADR-0025 — goal_scope proposed_change. `scope_knowledge_ids` are
// the AI-inferred + user-confirmable nodes the goal covers; `sequence_hint` is
// AI-internal ordering (NOT a progress metric, ND-4). The user can edit any of
// these before accepting (W10 inbox UI) — accept materializes the goal row.
export const GoalScopeProposalChange = z.object({
  title: z.string().min(1).max(280),
  // nullable / optional — cross-subject goals allowed (ND-1).
  subject_id: z.string().min(1).nullable().optional(),
  scope_knowledge_ids: z.array(z.string().min(1)).default([]),
  sequence_hint: z.number().int().min(0).default(0),
  reasoning: z.string().min(1).max(4000),
});
export type GoalScopeProposalChangeT = z.infer<typeof GoalScopeProposalChange>;

// YUK-202 / BlockAssembly path-B (design 2026-06-02 §1) — block_merge
// proposed_change. `primary_block_id` keeps its structured tree; `merge_block_ids`
// fold into it (min 1). `ingestion_session_id` scopes the merge (mergeQuestions is
// same-session only). `continuity_signal` is the AI's semantic-only cue (§0:
// spatial/bbox page-edge detection is DEFERRED to slice 2b — the task gains a
// spatial input later with no rework); optional because low-signal candidates can
// still propose. Acceptance reuses the YUK-195 `mergeQuestions` primitive.
export const BlockMergeProposalChange = z.object({
  primary_block_id: z.string().min(1),
  merge_block_ids: z.array(z.string().min(1)).min(1),
  ingestion_session_id: z.string().min(1),
  continuity_signal: z
    .enum(['page_edge', 'numbering', 'stem_answer_split', 'carryover'])
    .optional(),
  // YUK-202 fork 4a — the AI's 0..1 confidence in this merge candidate, persisted
  // at propose time so the inbox can sort/colour by it (consumed by the redraw UI
  // slice, YUK-169). The model's confidence is not recoverable after the run, so
  // it must be stored now even though the v1 inbox does not yet display it.
  confidence: z.number().min(0).max(1).optional(),
});
export type BlockMergeProposalChangeT = z.infer<typeof BlockMergeProposalChange>;

// YUK-227 S3 Slice C (ADR-0002) — image_candidate proposed_change. The page URL +
// title + the agent's summary of why it judged the source image-type. NO image bytes
// here: the bytes are downloaded from `source_url` only on accept (the accept handler
// in actions.ts is the single VLM 抽图 trigger — there is no auto path). Mirrors the
// SourcingImageCandidate output shape (src/core/schema/sourcing.ts).
export const ImageCandidateProposalChange = z.object({
  source_url: z.string().url(),
  source_title: z.string().min(1),
  summary_md: z.string().min(1).max(4000),
  // YUK-227 S3 Slice C (FIX-3) — the knowledge_ids the sourcing job already
  // resolved for this run (same archived-filtered live nodes the text path
  // attributes its drafts to). Carried at propose time so the accept handler can
  // attribute the materialized question WITHOUT re-resolving — the text path
  // stamps these on the question.knowledge_ids column, so the image path must too
  // or the materialized question is orphaned (unattributable to the originating
  // 知识点). Optional + defaulted: a legacy proposal written before this field
  // (or a run that resolved no node) parses to [] and the accept handler inserts
  // an empty attribution exactly as before — no behaviour regression.
  knowledge_ids: z.array(z.string().min(1)).default([]),
  // YUK-227 S3 Slice C (FIX-R2-5) — the 题型约束 the sourcing run was pinned to (if
  // any). The text path enforces kindsMatch per question; image candidates carry no
  // per-question kind at propose time (the stem is unread until accept's VLM), so the
  // run-level requested kind is stamped here and the accept handler normalizes it
  // through the single-authority question-kind vocabulary (src/subjects/question-kind.ts)
  // to set question.kind. Optional + free-string: a legacy proposal or an unpinned run
  // omits it and accept falls back to short_answer (the prior unconditional behaviour);
  // the value is validated/normalized at accept time (an unrecognised value also falls
  // back), not here, so a relaxed string keeps the proposal write tolerant.
  requested_kind: z.string().min(1).optional(),
});
export type ImageCandidateProposalChangeT = z.infer<typeof ImageCandidateProposalChange>;

// ADR-0031 / YUK-304 (lane B) — question_draft proposed_change. `question_id` is
// the ALREADY-INSERTED draft row (written in the same tx as this proposal by
// runQuestionAuthor — see src/server/ai/question-author.ts); the rest is a
// display/audit snapshot so the inbox card can render without a question join.
// Accept reads `question_id` and promotes draft→active + FSRS-enrolls.
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

// ADR-0032 D6-B (YUK-203 lane L6) — question_edit proposed_change. The edit is a
// NARROW, typed node operation (NOT an arbitrary JSON patch): one op per
// proposal, addressing a node by its `node_id` in the active question's
// `structured` tree (the same id/role coordinate the L5 addressable projection
// exposes). Each op is intentionally scoped to a single structured-node field so
// the accept-side verify gate can re-derive the resulting tree and re-validate
// the StructuredQuestion invariants before persisting:
//   - edit_node_text   — overwrite a node's prompt_text (stem passage / leaf 题面).
//   - edit_reference    — overwrite a leaf node's answers + analysis (参考答案/解析).
//   - set_choice        — replace the option list of a single-choice/leaf node.
//   - set_node_kind     — set the advisory `kind` hint on a node (no pool effect).
// `question_id` names the active question row; `node_id` names the target node.
export const QuestionEditOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('edit_node_text'),
    node_id: z.string().min(1),
    prompt_text: z.string().min(1),
  }),
  z.object({
    op: z.literal('edit_reference'),
    node_id: z.string().min(1),
    // Both optional individually, but the tool/applier require at least one to be
    // present (an edit must change something). answers replaces the full list.
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
  question_id: z.string().min(1),
  edit: QuestionEditOp,
  // Display-only excerpt for the inbox card (the question row is the source of
  // truth — accept re-reads the live tree, never trusts this snapshot).
  node_preview: z.string().optional(),
});
export type QuestionEditProposalChangeT = z.infer<typeof QuestionEditProposalChange>;

// YUK-440 / YUK-406 (教研团 Phase 0) — conjecture proposed_change. A first-class
// belief about the learner's mind, induced by the nightly research-meeting job from
// a recurring (cause_category × KC) failure cell. The conjecture IS the qualitative
// claim AND its falsifiable prediction: `predicted_p` is the claim's implied P(owner
// answers the probe correctly), and `baseline_p_at_induction` snapshots the
// quantitative PFA/θ p(L) the claim must beat (scored later by scorePrediction).
// `confidence` is internal ranking/calibration only — the read model strips it and it
// is NEVER rendered as a number (anti-false-precision). `discriminating` asserts the
// probe is one only THIS misconception produces a wrong answer to — a hard
// precondition (with recurrence_count ≥ 2) for the typed-ledger writing
// `confused-with-X`, so a single off-target failure cannot flip the ledger to a
// misconception state (the consistency-gate role YUK-344 plays in Phase 1+; Phase 0
// substitutes this in-payload contract). See docs/design/2026-06-27-a13-ts-half-design.md.
export const ConjectureProposalChange = z.object({
  claim_md: z.string().min(1).max(280),
  knowledge_id: z.string().min(1),
  cause_category: CauseCategory,
  confidence: z.number().min(0).max(1),
  recurrence_count: z.number().int().min(2),
  probe_md: z.string().min(1).max(2000),
  discriminating: z.boolean(),
  corrected_by_owner: z.boolean().default(false),
  predicted_p: z.number().min(0).max(1),
  baseline_p_at_induction: z.number().min(0).max(1),
});
export type ConjectureProposalChangeT = z.infer<typeof ConjectureProposalChange>;

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
  // YUK-202 / BlockAssembly path-B (design 2026-06-02 §1).
  BaseProposal.extend({
    kind: z.literal('block_merge'),
    target: ProposalTarget.extend({ subject_kind: z.literal('question_block') }),
    proposed_change: BlockMergeProposalChange,
  }),
  // YUK-227 S3 Slice C (ADR-0002) — image-type source candidate. target.subject_kind
  // is 'source_asset' (the materialized asset the accept handler will create); the
  // subject_id is null at propose time (the asset does not exist until accept).
  BaseProposal.extend({
    kind: z.literal('image_candidate'),
    target: ProposalTarget.extend({ subject_kind: z.literal('source_asset') }),
    proposed_change: ImageCandidateProposalChange,
  }),
  // ADR-0031 / YUK-304 (lane B) — copilot-authored draft question. target is the
  // already-inserted draft question row (subject_id = question id, known at
  // propose time — contrast image_candidate whose asset is minted on accept).
  BaseProposal.extend({
    kind: z.literal('question_draft'),
    target: ProposalTarget.extend({ subject_kind: z.literal('question') }),
    proposed_change: QuestionDraftProposalChange,
  }),
  // ADR-0032 D6-B (YUK-203 lane L6) — active-question structured node edit. target
  // is the live active question row (subject_id = question id, known at propose
  // time). Accept applies the narrow op to question.structured (practice package
  // applier) behind a mini verify gate; reversible via the audit event.
  BaseProposal.extend({
    kind: z.literal('question_edit'),
    target: ProposalTarget.extend({ subject_kind: z.literal('question') }),
    proposed_change: QuestionEditProposalChange,
  }),
  // YUK-440 / YUK-406 (教研团 Phase 0) — conjecture about the learner's mind. target
  // subject_kind 'mind_model' with subject_id = the knowledge_id the belief is about
  // (the conjecture is not an edit to any persisted row — it is a hypothesis-as-event).
  // accept/edit/reject are handled by acceptConjectureProposal (agency package).
  // Flows through the existing experimental:proposal event/inbox path
  // (writeAiProposal default + proposalWhere).
  BaseProposal.extend({
    kind: z.literal('conjecture'),
    target: ProposalTarget.extend({ subject_kind: z.literal('mind_model') }),
    proposed_change: ConjectureProposalChange,
  }),
]);
export type AiProposalPayloadT = z.infer<typeof AiProposalPayload>;
export type AiProposalPayloadInputT = z.input<typeof AiProposalPayload>;

export function parseAiProposalPayload(input: unknown): AiProposalPayloadT {
  return AiProposalPayload.parse(input);
}

// P5.6 / YUK-178 (ND-SK-1) — absence === 'proactive'. The single reader helper
// so the default-to-proactive rule lives in one place; the KPI gate
// (signals.ts) and any future reader resolve the kind through this. A corrective
// proposal must have explicitly set the field at emit (producer hard-set for
// variant_question, or model-labeled via the propose-tool arg).
export function resolveSuggestionKind(payload: {
  suggestion_kind?: SuggestionKindT;
}): SuggestionKindT {
  return payload.suggestion_kind ?? 'proactive';
}

import { z } from 'zod';
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
] as const;

export const AiProposalKind = z.enum(aiProposalKinds);
export type AiProposalKindT = z.infer<typeof AiProposalKind>;

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

export const KnowledgeEdgeProposalChange = z.object({
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: RelationTypeSchema,
  weight: z.number().min(0).max(1).default(1),
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
});
export type ImageCandidateProposalChangeT = z.infer<typeof ImageCandidateProposalChange>;

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

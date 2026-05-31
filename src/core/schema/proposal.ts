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

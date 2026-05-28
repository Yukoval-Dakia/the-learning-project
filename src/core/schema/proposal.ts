import { z } from 'zod';
import { RelationTypeSchema } from './event/blocks';

export const aiProposalKinds = [
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
  'archive',
  'judge_retraction',
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
]);
export type AiProposalPayloadT = z.infer<typeof AiProposalPayload>;
export type AiProposalPayloadInputT = z.input<typeof AiProposalPayload>;

export function parseAiProposalPayload(input: unknown): AiProposalPayloadT {
  return AiProposalPayload.parse(input);
}

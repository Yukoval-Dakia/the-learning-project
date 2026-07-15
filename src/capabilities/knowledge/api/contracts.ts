import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { ApiPageSchema } from '@/kernel/http-contracts';
import { SubjectProfileSchema } from '@/subjects/profile-schema';
import { z } from 'zod';

export const KnowledgeIdParamsSchema = z.object({ id: z.string().trim().min(1) });

export const KnowledgeTreeNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  parent_id: z.string().nullable(),
  archived_at: z.string().nullable(),
  mastery: z.number().nullable(),
  mastery_lo: z.number().nullable(),
  mastery_hi: z.number().nullable(),
  low_confidence: z.boolean(),
  evidence_count: z.number().int().nonnegative(),
  last_evidence_at: z.string().nullable(),
  last_active_at: z.string(),
  effective_domain: z.string().nullable(),
});

export const KnowledgeTreeResponseSchema = z.object({ rows: z.array(KnowledgeTreeNodeSchema) });

export const LegacyKnowledgeProposalQuerySchema = z.object({
  status: z.string().default('pending'),
});

export const LegacyKnowledgeProposalSchema = z.object({
  id: z.string(),
  kind: z.string(),
  payload: z.record(z.unknown()),
  reasoning: z.string(),
  status: z.enum(['pending', 'accepted', 'dismissed', 'stale', 'rubric_rejected']),
  proposed_at: z.string(),
  decided_at: z.string().nullable(),
});

export const LegacyKnowledgeProposalListResponseSchema = z.object({
  rows: z.array(LegacyKnowledgeProposalSchema),
});

export const LegacyKnowledgeProposalDecisionBodySchema = z.object({
  decision: z.enum(['accept', 'reject']),
});

export const LegacyKnowledgeProposalDecisionResponseSchema = z
  .object({ kind: z.string() })
  .passthrough();

export const KnowledgeEdgeQuerySchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  relation_type: z.string().min(1).optional(),
  include_archived: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().positive().max(500).default(500),
  cursor: z.string().min(1).optional(),
});

export const CreateKnowledgeEdgeBodySchema = z.object({
  from_knowledge_id: z.string().min(1, 'from_knowledge_id is required'),
  to_knowledge_id: z.string().min(1, 'to_knowledge_id is required'),
  relation_type: RelationTypeSchema,
  weight: z.number().min(0).max(1).optional(),
  reasoning: z.string().nullable().optional(),
});

export const KnowledgeEdgeSchema = z.object({
  id: z.string(),
  from_knowledge_id: z.string(),
  to_knowledge_id: z.string(),
  relation_type: RelationTypeSchema,
  weight: z.number(),
  created_by: z.unknown(),
  reasoning: z.string().nullable(),
  created_at: z.string(),
  archived_at: z.string().nullable(),
});

export const KnowledgeEdgeCollectionResponseSchema = z
  .object({
    data: z.array(KnowledgeEdgeSchema),
    page: ApiPageSchema,
    rows: z.array(KnowledgeEdgeSchema),
    next_cursor: z.string().nullable(),
  })
  .passthrough();

export const CreateKnowledgeEdgeResponseSchema = z.object({ id: z.string() });

export const LegacyKnowledgeEdgeDecisionBodySchema = z
  .object({
    decision: z.enum(['accept', 'reverse', 'change_type', 'dismiss']),
    new_relation_type: RelationTypeSchema.optional(),
    user_note: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.decision === 'change_type' && !data.new_relation_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'change_type requires new_relation_type',
        path: ['new_relation_type'],
      });
    }
  });

export const LegacyKnowledgeEdgeDecisionResponseSchema = z.object({
  rate_event_id: z.string(),
  generate_event_id: z.string().nullable(),
  edge_id: z.string().nullable(),
  idempotent: z.boolean().optional(),
});

export const KnowledgeReviewDueSummaryResponseSchema = z.object({
  now: z.string(),
  due_soon_window_hours: z.number().int().positive(),
  summary: z.record(
    z.object({
      overdue: z.number().int().nonnegative(),
      due_soon: z.number().int().nonnegative(),
    }),
  ),
});

export const KnowledgeFrontierItemSchema = z.object({
  kid: z.string(),
  name: z.string(),
  reason: z.string(),
  propose: z.boolean(),
  lowConf: z.boolean(),
  mastery: z.number().nullable(),
  mastery_lo: z.number().nullable(),
  mastery_hi: z.number().nullable(),
  low_confidence: z.boolean(),
  evidence_count: z.number().int().nonnegative(),
});

export const KnowledgeFrontierResponseSchema = z.object({
  rows: z.array(KnowledgeFrontierItemSchema),
});

const NodePageNoteSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  knowledge_ids: z.array(z.string()),
  generation_status: z.string(),
  verification_status: z.string(),
  version: z.number().int(),
  updated_at: z.string(),
});

const NodePageBacklinkSchema = z.object({
  from_artifact_id: z.string(),
  from_learning_item_id: z.string().nullable(),
  from_title: z.string(),
  from_type: z.string(),
  from_block_id: z.string(),
});

const NodePageBodyBlocksSchema = z
  .object({
    type: z.literal('doc'),
    content: z.array(z.unknown()),
  })
  .passthrough();

export const KnowledgeNodePageResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  parent_id: z.string().nullable(),
  parent_name: z.string().nullable(),
  effective_domain: z.string().nullable(),
  mastery: z.number().nullable(),
  mastery_lo: z.number().nullable(),
  mastery_hi: z.number().nullable(),
  low_confidence: z.boolean(),
  evidence_count: z.number().int().nonnegative(),
  retrievability: z.number().nullable(),
  beta: z.number().nullable(),
  last_evidence_at: z.string().nullable(),
  mastery_decay_bucket: z.enum(['untrained', 'fresh', 'mild', 'stale', 'unknown']),
  subject_profile: SubjectProfileSchema.pick({
    id: true,
    displayName: true,
    renderConfig: true,
  }),
  children: z.array(z.object({ id: z.string(), name: z.string(), mastery: z.number().nullable() })),
  mesh_neighbors: z.array(
    z.object({
      edge_id: z.string(),
      knowledge_id: z.string(),
      name: z.string(),
      relation_type: z.string(),
      direction: z.enum(['out', 'in']),
      weight: z.number(),
    }),
  ),
  primary_atomic: z
    .object({
      id: z.string(),
      owning_learning_item_id: z.string().nullable(),
      title: z.string(),
      version: z.number().int(),
      body_blocks: NodePageBodyBlocksSchema.nullable(),
      generation_status: z.string(),
      verification_status: z.string(),
    })
    .nullable(),
  notes: z.array(NodePageNoteSummarySchema),
  interactive_artifacts: z.array(NodePageNoteSummarySchema),
  backlinks: z.array(NodePageBacklinkSchema),
  backlinks_by_type: z.record(z.array(NodePageBacklinkSchema)),
  timeline: z.array(
    z.object({
      event_id: z.string(),
      action: z.string(),
      subject_kind: z.string(),
      actor_kind: z.string(),
      outcome: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});

export const KnowledgeMisconceptionSchema = z.object({
  id: z.string(),
  segment: z.enum(['confirmed', 'candidate']),
  label: z.string(),
  belief: z.string(),
  status: z.enum(['active', 'fading']),
  source: z.enum(['hard', 'soft']),
  conf: z.enum(['高', '中', '低']),
  seen: z.number().int().nonnegative(),
  evidence: z.array(z.string()),
});

export const KnowledgeMisconceptionListResponseSchema = z.object({
  rows: z.array(KnowledgeMisconceptionSchema),
});

export const LegacyKnowledgeMisconceptionVetoResponseSchema = z.object({
  kind: z.literal('dismissed'),
  rate_event_id: z.string().nullable(),
  idempotent: z.boolean().optional(),
});

import {
  ArtifactBodyBlocks,
  ArtifactHistoryEntry,
  CorrectArtifactEvent,
  NoteSection,
  NoteVerificationResult,
  SubjectProfileSchema,
} from '@/kernel/capability-contract-schemas';
import { z } from 'zod';

export const NoteIdParamsSchema = z.object({ id: z.string().trim().min(1) });

export const ArtifactIdParamsSchema = z.object({ id: z.string().trim().min(1) });

export const ArtifactSectionParamsSchema = z.object({
  id: z.string().trim().min(1),
  sectionId: z.string().trim().min(1),
});

export const ArtifactAiChangeParamsSchema = z.object({
  id: z.string().trim().min(1),
  eventId: z.string().trim().min(1),
});

export const HubIdParamsSchema = z.object({ id: z.string().trim().min(1) });

export const ArtifactSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  exclude: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(25).optional(),
});

export const ArtifactSearchResponseSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      type: z.string(),
    }),
  ),
});

const NotePageBacklinkSchema = z.object({
  from_artifact_id: z.string(),
  from_learning_item_id: z.string().nullable(),
  from_title: z.string(),
  from_type: z.string(),
  from_block_id: z.string(),
});

// zod-to-json-schema cannot faithfully emit the recursive TipTap node graph.
// Keep the public wire boundary explicit and shallow while route handlers still
// validate writes with the canonical recursive ArtifactBodyBlocks schema.
const ArtifactBodyBlocksWireSchema = z
  .object({
    type: z.literal('doc'),
    content: z.array(z.unknown()),
  })
  .passthrough();

export const NotePageResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  knowledge_ids: z.array(z.string()),
  labels: z.array(z.object({ id: z.string(), name: z.string() })),
  body_blocks: ArtifactBodyBlocksWireSchema.nullable(),
  sections: z.array(NoteSection),
  generation_status: z.string(),
  verification_status: z.string(),
  verification_summary: NoteVerificationResult.nullable(),
  interactive: z.object({ html: z.string() }).nullable(),
  subject_profile: SubjectProfileSchema.pick({
    id: true,
    displayName: true,
    renderConfig: true,
  }),
  version: z.number().int().nonnegative(),
  history: z.array(ArtifactHistoryEntry),
  backlinks: z.array(NotePageBacklinkSchema),
  backlinks_by_type: z.record(z.array(NotePageBacklinkSchema)),
  related_learning_items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      relation: z.enum(['primary', 'label']),
    }),
  ),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const EditArtifactBodyBlocksBodySchema = z.object({
  artifact_version: z.number().int().nonnegative(),
  body_blocks: ArtifactBodyBlocks,
});

export const EditArtifactBodyBlocksRequestContractSchema = z.object({
  artifact_version: z.number().int().nonnegative(),
  body_blocks: ArtifactBodyBlocksWireSchema,
});

export const EditArtifactBodyBlocksResponseSchema = z.object({
  artifact_id: z.string(),
  artifact_version: z.number().int().nonnegative(),
  body_blocks: ArtifactBodyBlocksWireSchema,
  event_id: z.string(),
});

export const EditArtifactSectionBodySchema = z.object({
  artifact_version: z.number().int().nonnegative(),
  section_version: z.number().int().nonnegative(),
  body_md: z.string().max(50_000),
});

export const EditArtifactSectionResponseSchema = z.object({
  artifact_id: z.string(),
  artifact_version: z.number().int().nonnegative(),
  section: NoteSection,
  event_id: z.string(),
});

export const ArtifactBacklinkSchema = NotePageBacklinkSchema.extend({
  snippet: z.string().nullable(),
});

export const ArtifactBacklinksResponseSchema = z.object({
  artifact_id: z.string(),
  rows: z.array(ArtifactBacklinkSchema),
});

export const ArtifactCorrectionStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('active'),
    correction_event_id: z.null(),
    replacement_artifact_id: z.null(),
  }),
  z.object({
    state: z.literal('retracted'),
    correction_event_id: z.string(),
    replacement_artifact_id: z.null(),
  }),
  z.object({
    state: z.literal('marked_wrong'),
    correction_event_id: z.string(),
    replacement_artifact_id: z.null(),
  }),
  z.object({
    state: z.literal('superseded'),
    correction_event_id: z.string(),
    replacement_artifact_id: z.string(),
  }),
]);

export const ArtifactCorrectionStateResponseSchema = z.object({
  artifact_id: z.string(),
  whole: ArtifactCorrectionStatusSchema,
  blocks: z.record(ArtifactCorrectionStatusSchema),
});

const CorrectArtifactPayloadSchema = CorrectArtifactEvent.innerType().shape.payload;

export const CorrectArtifactBodySchema = CorrectArtifactPayloadSchema.superRefine((data, ctx) => {
  if (data.correction_kind === 'supersede' && !data.replacement_artifact_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "replacement_artifact_id is required when correction_kind='supersede'",
      path: ['replacement_artifact_id'],
    });
  }
  if (data.correction_kind !== 'supersede' && data.replacement_artifact_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "replacement_artifact_id is only allowed when correction_kind='supersede'",
      path: ['replacement_artifact_id'],
    });
  }
});

export const CreateArtifactCorrectionResponseSchema = z.object({
  correction_event_id: z.string(),
});

export const NoteRefineChangeSchema = z.object({
  event_id: z.string(),
  artifact_id: z.string(),
  created_at: z.string().datetime(),
  actor_ref: z.string(),
  ops_count: z.number().int().nonnegative(),
  new_blocks: z.number().int().nonnegative(),
  previous_artifact_version: z.number().int().nonnegative(),
  next_artifact_version: z.number().int().nonnegative(),
  undone: z.boolean(),
});

export const ArtifactAiChangesResponseSchema = z.object({
  artifact_id: z.string(),
  rows: z.array(NoteRefineChangeSchema),
});

export const RecentArtifactAiChangesResponseSchema = z.object({
  window_hours: z.literal(24),
  rows: z.array(NoteRefineChangeSchema),
});

export const UndoArtifactAiChangeResponseSchema = z.object({
  status: z.enum(['undone', 'skipped:already_undone', 'skipped:version_conflict']),
  artifact_id: z.string(),
  event_id: z.string().optional(),
  artifact_version: z.number().int().nonnegative().optional(),
});

export const DismissHubLinkBodySchema = z
  .object({
    suppressed_artifact_id: z.string().trim().min(1),
    relation: z.enum(['subtopic', 'prerequisite', 'derived_from', 'contrasts_with']).optional(),
  })
  .strict();

export const DismissHubLinkResponseSchema = z.object({
  hub_id: z.string(),
  suppressed_artifact_id: z.string(),
  suppress_event_id: z.string(),
  removed: z.boolean(),
});

export const EditingHeartbeatBodySchema = z.object({
  artifact_id: z.string().min(1),
  // YUK-384 — editing presence is session-qualified; one UUID per mounted editor
  // session so a heartbeat upserts only that session's row.
  editor_session_id: z.string().uuid(),
  status: z.enum(['editing', 'idle']).default('editing'),
});

export const EditingHeartbeatResponseSchema = z.object({ ok: z.literal(true) });

export const EditingBlurBodySchema = z.object({
  artifact_id: z.string().min(1),
  editor_session_id: z.string().uuid(),
});

export const NoteRefineApplyResultSchema = z.object({
  status: z.enum([
    'applied',
    'skipped:empty_patch',
    'skipped:target_not_found',
    'skipped:not_found',
    'skipped:archived',
    'skipped:version_conflict',
  ]),
  artifact_id: z.string(),
  event_id: z.string().optional(),
  ops_count: z.number().int().nonnegative().optional(),
  new_blocks: z.number().int().nonnegative().optional(),
  artifact_version: z.number().int().nonnegative().optional(),
  skipped_ops: z.number().int().nonnegative().optional(),
});

export const EditingBlurResponseSchema = z.object({
  artifact_id: z.string(),
  flushed: z.number().int().nonnegative(),
  results: z.array(NoteRefineApplyResultSchema),
});

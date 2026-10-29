import { z } from 'zod';
import { PublicMaterialView } from '@/core/schema/assessment';
import { CauseCategory } from '@/kernel/capability-contract-schemas';

const MistakeCorrectionStepSchema = z.object({
  event_id: z.string(),
  state: z.enum(['active', 'retracted', 'marked_wrong', 'superseded']),
  correction_event_id: z.string().nullable(),
  replacement_event_id: z.string().nullable(),
});

const MistakeCorrectionStateSchema = z.object({
  original_event_id: z.string(),
  state: z.enum(['active', 'retracted', 'marked_wrong', 'superseded', 'missing', 'cycle']),
  terminal_state: z.enum(['active', 'retracted', 'marked_wrong', 'missing', 'cycle']),
  effective_event_id: z.string().nullable(),
  correction_event_id: z.string().nullable(),
  replacement_event_id: z.string().nullable(),
  chain: z.array(MistakeCorrectionStepSchema),
});

const PromptMaterialTextSchema = PublicMaterialView.omit({ asset_id: true });

/** Frozen public material only. Available means asset metadata matches; blob delivery is separate. */
export const MistakePromptMaterialSchema = z.discriminatedUnion('availability', [
  PromptMaterialTextSchema.extend({
    availability: z.literal('inline'),
    kind: PublicMaterialView.shape.kind.extract(['passage', 'table', 'plaintext']),
    content_md: z.string(),
  }).strict(),
  PublicMaterialView.extend({ availability: z.literal('available') }).strict(),
  PromptMaterialTextSchema.extend({
    // Missing row and present-but-incompatible metadata are distinct. Neither exposes a download ID.
    availability: z.enum(['missing', 'unavailable']),
  }).strict(),
]);

export const MistakeProjectionSchema = z.object({
  id: z.string(),
  record_id: z.string(),
  question_id: z.string(),
  prompt_md: z.string(),
  prompt_materials: z.array(MistakePromptMaterialSchema).default([]),
  reference_md: z.string().nullable(),
  wrong_answer_md: z.string(),
  wrong_answer_image_refs: z.array(z.string()).default([]),
  knowledge_ids: z.array(z.string()),
  cause: z
    .object({
      source: z.enum(['agent', 'user']),
      primary_category: CauseCategory,
      // Display backfill from active misconception titles; null when not a misc id.
      primary_label: z.string().nullable(),
      secondary_categories: z.array(CauseCategory),
      // Display backfill for misc ids; absent entries fall back to raw ids.
      secondary_labels: z.record(z.string(), z.string()),
      user_notes: z.string().nullable(),
      confidence: z.number().min(0).max(1).nullable(),
    })
    .nullable(),
  correction_state: MistakeCorrectionStateSchema,
  created_at: z.number().int().nonnegative(),
});

export type MistakeProjection = z.infer<typeof MistakeProjectionSchema>;

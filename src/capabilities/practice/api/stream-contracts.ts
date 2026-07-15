import { z } from 'zod';

export const PracticeStreamCalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PracticeStreamQuerySchema = z.object({
  // `?date=` is treated like an omitted date by the existing handler.
  date: z.union([z.literal(''), z.literal('today'), PracticeStreamCalendarDateSchema]).optional(),
});

export const RecomposePracticeStreamBodySchema = z.object({
  date: z.string().optional(),
});

export const PracticeStreamItemStatusSchema = z.enum(['pending', 'in_progress', 'done', 'skipped']);

export const UpdatePracticeStreamItemBodySchema = z.object({
  status: PracticeStreamItemStatusSchema,
});

const PracticeStreamItemKindSchema = z.enum(['question', 'paper']);
const PracticeStreamItemSourceSchema = z.enum([
  'decay',
  'variant',
  'new_check',
  'paper',
  'on_demand',
  'import',
  'frontier',
]);

const PracticeStreamViewItemSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  item_kind: PracticeStreamItemKindSchema,
  ref_id: z.string(),
  source: PracticeStreamItemSourceSchema,
  reasoning: z.string(),
  status: PracticeStreamItemStatusSchema,
  estimated_minutes: z.number().nonnegative(),
});

export const PracticeStreamResponseSchema = z.object({
  date: z.string(),
  opening_line: z.string(),
  items: z.array(PracticeStreamViewItemSchema),
  budget: z.object({
    pace: z.enum(['light', 'medium', 'dense']),
    minutes: z.number().nonnegative(),
  }),
  progress: z.object({
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    estimated_total_minutes: z.number().nonnegative(),
    estimated_remaining_minutes: z.number().nonnegative(),
  }),
});

export const PracticeStreamRecomposedResponseSchema = PracticeStreamResponseSchema.extend({
  added: z.number().int().nonnegative(),
});

const PersistedPracticeStreamItemSchema = z.object({
  id: z.string(),
  date: z.string(),
  position: z.number().int(),
  item_kind: PracticeStreamItemKindSchema,
  ref_id: z.string(),
  source: PracticeStreamItemSourceSchema,
  status: PracticeStreamItemStatusSchema,
  reasoning: z.string(),
  added_by: z.enum(['composer_nightly', 'composer_live', 'copilot', 'user']),
  signals: z.record(z.unknown()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  estimated_minutes: z.number().nonnegative(),
});

export const PracticeStreamItemUpdatedResponseSchema = z.object({
  item: PersistedPracticeStreamItemSchema,
});

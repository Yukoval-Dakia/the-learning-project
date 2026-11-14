import { z } from 'zod';
export const DraftFocus = z
  .object({
    question_id: z.string().min(1),
    issuance_id: z.string().min(1),
    revision_id: z.string().min(1),
    save_epoch: z.number().int().positive(),
  })
  .strict();
export type DraftFocusT = z.infer<typeof DraftFocus>;

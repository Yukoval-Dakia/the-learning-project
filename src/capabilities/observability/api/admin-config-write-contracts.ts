import { z } from 'zod';

const KeySchema = z.string().min(1).max(200);
const ValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.string()),
  z.record(z.string(), z.unknown()),
]);
const MutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), key: KeySchema, value: ValueSchema }).strict(),
  z.object({ action: z.literal('clear'), key: KeySchema }).strict(),
]);

export const AdminConfigWriteBodySchema = z
  .object({
    changes: z.array(MutationSchema).min(1).max(256),
    note: z.string().max(2000).optional(),
  })
  .strict();

export const AdminConfigResetBodySchema = z
  .object({
    keys: z.array(KeySchema).min(1).max(256),
    note: z.string().max(2000).optional(),
  })
  .strict();

export const AdminConfigWriteResponseSchema = z.object({
  committed_epoch: z.number().int().positive(),
  snapshot_epoch: z.number().int().nonnegative(),
  snapshot_current: z.boolean(),
  changes: z.array(
    z.object({
      key: z.string(),
      revision: z.number().int().positive(),
      epoch: z.number().int().positive(),
      action: z.enum(['set', 'clear']),
      cleared: z.boolean().optional(),
    }),
  ),
});

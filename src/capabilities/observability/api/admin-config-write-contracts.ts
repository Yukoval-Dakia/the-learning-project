import { z } from 'zod';
import type { AdminConfigWriteResult } from '@/core/config/contracts/admin';
import {
  AdminConfigGlobalEffectiveSchema,
  AdminConfigTaskEffectiveBindingSchema,
} from './admin-config-contracts';

const KeySchema = z.string().min(1).max(200);
const ValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.string()),
  z.record(z.string(), z.unknown()),
]);
const MutationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('set'),
      key: KeySchema,
      value: ValueSchema,
      /** YUK-1557 — optional hard stop; expired rows fall through to env/default. */
      expires_at: z.string().datetime({ offset: true }).nullable().optional(),
    })
    .strict(),
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
  /**
   * YUK-1808 — post-write effective projection for the touched scopes, resolved
   * by the same resolvers the runtime uses (never the stored override rows):
   * every touched task.<kind>.* key contributes its kind's effective binding;
   * a touched lane.global.* contributes `global`. Untouched sections stay empty.
   */
  effective: z.object({
    tasks: z.record(z.string(), AdminConfigTaskEffectiveBindingSchema),
    global: AdminConfigGlobalEffectiveSchema.nullable(),
  }),
});

/**
 * Compile-time guard: the wire schema's output must satisfy the config owner's
 * writer receipt contract (`AdminConfigWriteResult`). A drift on either side
 * fails typecheck instead of silently changing the admin response shape.
 */
type ContractMatch<T extends true> = T;
export type AdminConfigWriteWireContractMatch = ContractMatch<
  z.infer<typeof AdminConfigWriteResponseSchema> extends AdminConfigWriteResult ? true : false
>;

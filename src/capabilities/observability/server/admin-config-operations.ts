import type { z } from 'zod';
import { ApiError } from '@/kernel/http';
import {
  AdminConfigResetBodySchema,
  AdminConfigWriteBodySchema,
} from '../api/admin-config-write-contracts';
import { type AdminConfigWriteResult, getAdminConfigWriter } from './admin-config-writer';

export type AdminConfigWriteInput = z.infer<typeof AdminConfigWriteBodySchema>;
export type AdminConfigResetInput = z.infer<typeof AdminConfigResetBodySchema>;

export async function patchAdminConfig(input: unknown): Promise<AdminConfigWriteResult> {
  const body = AdminConfigWriteBodySchema.safeParse(input);
  if (!body.success)
    throw new ApiError('invalid_config_request', 'Expected changes and an optional note', 400);
  const writer = getAdminConfigWriter();
  if (!writer)
    throw new ApiError('config_writer_unavailable', 'Configuration writer is unavailable', 503);
  return writer(body.data.changes, body.data.note);
}

export async function resetAdminConfig(input: unknown): Promise<AdminConfigWriteResult> {
  const body = AdminConfigResetBodySchema.safeParse(input);
  if (!body.success)
    throw new ApiError('invalid_config_request', 'Expected keys and an optional note', 400);
  const writer = getAdminConfigWriter();
  if (!writer)
    throw new ApiError('config_writer_unavailable', 'Configuration writer is unavailable', 503);
  return writer(
    body.data.keys.map((key) => ({ action: 'clear', key })),
    body.data.note,
  );
}

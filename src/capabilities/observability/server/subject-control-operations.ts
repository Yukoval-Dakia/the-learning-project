import { z } from 'zod';
import type { Db } from '@/db/client';
import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import {
  type ControlWriteResult,
  type ValidateSubjectResult,
  renameSubject,
  resetSubject,
  restoreSubject,
  retireSubject,
  validateSubject,
} from '@/server/subjects/subject-control-write';
import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import {
  AdminSubjectCasBodySchema,
  AdminSubjectControlParamsSchema,
  RenameAdminSubjectBodySchema,
} from '../api/subject-control-contracts';

export { AdminSubjectCasBodySchema, AdminSubjectControlParamsSchema, RenameAdminSubjectBodySchema };

// Preserve the running HTTP schema: partial enum records are accepted, alien keys rejected.
// The declaration schema in subject-control-contracts strips alien keys instead.
export const ValidateAdminSubjectInputSchema = z.object({
  traitPayloadOverrides: z.record(z.enum(SUBJECT_TRAIT_KINDS), z.unknown()).optional(),
});

export type RenameAdminSubjectInput = { subjectId: string } & z.infer<
  typeof RenameAdminSubjectBodySchema
>;
export type AdminSubjectCasInput = { subjectId: string } & z.infer<
  typeof AdminSubjectCasBodySchema
>;
export type ValidateAdminSubjectInput = { subjectId: string } & z.infer<
  typeof ValidateAdminSubjectInputSchema
>;
export type AdminSubjectControlResult = ControlWriteResult;
export type AdminSubjectValidationResult = ValidateSubjectResult;

async function hydrateCommittedResult(
  db: Db,
  result: AdminSubjectControlResult,
): Promise<AdminSubjectControlResult> {
  // Each writer owns its transaction. Hydration runs only after that transaction resolves.
  // Its existing never-throws report preserves last-good on failure; no retry or rollback.
  if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
  return result;
}

export async function renameAdminSubject(
  db: Db,
  input: RenameAdminSubjectInput,
): Promise<AdminSubjectControlResult> {
  return hydrateCommittedResult(db, await renameSubject(db, input));
}

export async function retireAdminSubject(
  db: Db,
  input: AdminSubjectCasInput,
): Promise<AdminSubjectControlResult> {
  return hydrateCommittedResult(db, await retireSubject(db, input));
}

export async function restoreAdminSubject(
  db: Db,
  input: AdminSubjectCasInput,
): Promise<AdminSubjectControlResult> {
  return hydrateCommittedResult(db, await restoreSubject(db, input));
}

export async function resetAdminSubject(
  db: Db,
  input: AdminSubjectCasInput,
): Promise<AdminSubjectControlResult> {
  return hydrateCommittedResult(db, await resetSubject(db, input));
}

export async function validateAdminSubject(
  db: Db,
  input: ValidateAdminSubjectInput,
): Promise<AdminSubjectValidationResult | null> {
  return validateSubject(db, input.subjectId, input.traitPayloadOverrides);
}

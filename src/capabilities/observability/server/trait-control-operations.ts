import { z } from 'zod';
import type { Db } from '@/db/client';
import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import * as writers from '@/server/subjects/trait-write';
import type { SubjectTraitKind } from '@/subjects/trait-schemas';
import {
  AdminSubjectTraitParamsSchema,
  AdminTraitWriteParamsSchema,
  ForkSubjectTraitBodySchema,
  RebindSubjectTraitBodySchema,
  ResetAdminTraitBodySchema,
  RollbackAdminTraitBodySchema,
} from '../api/trait-write-contracts';

export {
  AdminSubjectTraitParamsSchema,
  AdminTraitWriteParamsSchema,
  ForkSubjectTraitBodySchema,
  RebindSubjectTraitBodySchema,
  ResetAdminTraitBodySchema,
  RollbackAdminTraitBodySchema,
};

// The HTTP edit shells accept absent/unknown payloads. The writer validates them
// in its existing order and returns invalid (422), rather than a body error (400).
export const EditSubjectTraitInputSchema = z.object({
  expectedSubjectRevision: z.number().int().nonnegative(),
  expectedTraitRevision: z.number().int().nonnegative(),
  payload: z.unknown().optional(),
});
export const EditSharedTraitInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  payload: z.unknown().optional(),
});

type SubjectTraitInput = { subjectId: string; kind: SubjectTraitKind };
export type EditSubjectTraitInput = SubjectTraitInput & z.infer<typeof EditSubjectTraitInputSchema>;
export type ForkSubjectTraitInput = SubjectTraitInput & z.infer<typeof ForkSubjectTraitBodySchema>;
export type RebindSubjectTraitInput = SubjectTraitInput &
  z.infer<typeof RebindSubjectTraitBodySchema>;
export type EditSharedTraitInput = { traitId: string } & z.infer<typeof EditSharedTraitInputSchema>;
export type RollbackTraitInput = { traitId: string } & z.infer<typeof RollbackAdminTraitBodySchema>;
export type ResetTraitToSeedInput = { traitId: string } & z.infer<typeof ResetAdminTraitBodySchema>;
export type { FanoutIssue, TraitWriteResult } from '@/server/subjects/trait-write';

async function hydrateCommittedResult(
  db: Db,
  result: writers.TraitWriteResult,
): Promise<writers.TraitWriteResult> {
  // Each original writer resolves after its own transaction commits. The original
  // hydrator catches query failures and preserves last-good; never retry here.
  if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
  return result;
}

export async function editSubjectTrait(
  db: Db,
  input: EditSubjectTraitInput,
): Promise<writers.TraitWriteResult> {
  return hydrateCommittedResult(
    db,
    await writers.editSubjectTrait(db, { ...input, payload: input.payload }),
  );
}
export async function forkSubjectTrait(
  db: Db,
  input: ForkSubjectTraitInput,
): Promise<writers.TraitWriteResult> {
  return hydrateCommittedResult(db, await writers.forkSubjectTrait(db, input));
}
export async function rebindSubjectTrait(
  db: Db,
  input: RebindSubjectTraitInput,
): Promise<writers.TraitWriteResult> {
  return hydrateCommittedResult(db, await writers.rebindSubjectTrait(db, input));
}
export async function editSharedTrait(
  db: Db,
  input: EditSharedTraitInput,
): Promise<writers.TraitWriteResult> {
  return hydrateCommittedResult(
    db,
    await writers.editSharedTrait(db, { ...input, payload: input.payload }),
  );
}
export async function rollbackTrait(
  db: Db,
  input: RollbackTraitInput,
): Promise<writers.TraitWriteResult> {
  return hydrateCommittedResult(db, await writers.rollbackTrait(db, input));
}
export async function resetTraitToSeed(
  db: Db,
  input: ResetTraitToSeedInput,
): Promise<writers.TraitWriteResult> {
  return hydrateCommittedResult(db, await writers.resetTraitToSeed(db, input));
}

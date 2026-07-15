import { z } from 'zod';

import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';

const RevisionSchema = z.number().int().nonnegative();

export const AdminSubjectControlParamsSchema = z.object({ id: z.string().trim().min(1) });

export const RenameAdminSubjectBodySchema = z.object({
  expectedRevision: RevisionSchema,
  displayName: z.string(),
});

export const AdminSubjectCasBodySchema = z.object({
  expectedRevision: RevisionSchema,
});

export const ValidateAdminSubjectBodySchema = z.object({
  // The preflight endpoint intentionally accepts invalid candidates so it can report errors.
  traitPayloadOverrides: z.record(z.enum(SUBJECT_TRAIT_KINDS), z.unknown()).optional(),
});

export const AdminSubjectControlResponseSchema = z.object({
  subjectRevision: RevisionSchema,
  noop: z.literal(true).optional(),
});

export const ValidateAdminSubjectResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

import { z } from 'zod';

import { AdminSubjectParamsSchema } from './subject-contracts';

const RevisionSchema = z.number().int().nonnegative();

export const AdminSubjectControlParamsSchema = AdminSubjectParamsSchema;

export const RenameAdminSubjectBodySchema = z.object({
  expectedRevision: RevisionSchema,
  displayName: z.string(),
});

export const AdminSubjectCasBodySchema = z.object({
  expectedRevision: RevisionSchema,
});

export const ValidateAdminSubjectBodySchema = z.object({
  // The preflight endpoint intentionally accepts invalid candidates so it can report errors.
  // Spell out optional keys because zod-to-json-schema makes enum-keyed records exhaustive.
  traitPayloadOverrides: z
    .object({
      charter: z.unknown().optional(),
      judge_policy: z.unknown().optional(),
      cause_taxonomy: z.unknown().optional(),
      source_policy: z.unknown().optional(),
      render_theme: z.unknown().optional(),
      scheduling: z.unknown().optional(),
    })
    .optional(),
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

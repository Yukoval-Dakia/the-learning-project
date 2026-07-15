import { z } from 'zod';

import { ApiPageSchema } from '@/kernel/http-contracts';
import {
  CauseTaxonomyTraitSchema,
  CharterTraitSchema,
  JudgePolicyTraitSchema,
  RenderThemeTraitSchema,
  SUBJECT_TRAIT_KINDS,
  SchedulingTraitSchema,
  SourcePolicyTraitSchema,
} from '@/subjects/trait-schemas';

export const AdminSubjectParamsSchema = z.object({ id: z.string().trim().min(1) });
export const AdminTraitParamsSchema = z.object({ id: z.string().trim().min(1) });

export const AdminSubjectSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  origin: z.enum(['builtin', 'custom']),
  retiredAt: z.string().datetime().nullable(),
  isGeneralFallback: z.boolean().nullable(),
  version: z.string().nullable(),
  subjectRevision: z.number().int().nonnegative(),
  notation: z.string().nullable(),
  capabilityCount: z.number().int().nonnegative(),
});

export const AdminSubjectsResponseSchema = z.object({ subjects: z.array(AdminSubjectSchema) });

export const CreateAdminSubjectBodySchema = z.object({ displayName: z.string() });

export const CreatedAdminSubjectResponseSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  isGeneralFallback: z.boolean().nullable(),
  revision: z.number().int().nonnegative(),
  seedRootId: z.string(),
});

const AdminTraitBindingFields = {
  traitId: z.string(),
  origin: z.enum(['builtin', 'custom']),
  ownerSubjectId: z.string().nullable(),
  seedVersion: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  effectiveRevision: z.union([z.number().int().nonnegative(), z.string().regex(/^seed:/)]),
  degraded: z.enum(['journal_fallback', 'code_seed']).nullable(),
  sharedBy: z.array(z.string()),
};

export const AdminTraitBindingSchema = z.discriminatedUnion('kind', [
  z.object({ ...AdminTraitBindingFields, kind: z.literal('charter'), payload: CharterTraitSchema }),
  z.object({
    ...AdminTraitBindingFields,
    kind: z.literal('judge_policy'),
    payload: JudgePolicyTraitSchema,
  }),
  z.object({
    ...AdminTraitBindingFields,
    kind: z.literal('cause_taxonomy'),
    payload: CauseTaxonomyTraitSchema,
  }),
  z.object({
    ...AdminTraitBindingFields,
    kind: z.literal('source_policy'),
    payload: SourcePolicyTraitSchema,
  }),
  z.object({
    ...AdminTraitBindingFields,
    kind: z.literal('render_theme'),
    payload: RenderThemeTraitSchema,
  }),
  z.object({
    ...AdminTraitBindingFields,
    kind: z.literal('scheduling'),
    payload: SchedulingTraitSchema,
  }),
]);

export const AdminSubjectTraitsResponseSchema = z.object({
  subjectRevision: z.number().int().nonnegative(),
  bindings: z.array(AdminTraitBindingSchema),
});

export const AdminTraitsQuerySchema = z.object({ kind: z.enum(SUBJECT_TRAIT_KINDS) });

export const AdminTraitCatalogRowSchema = z.object({
  traitId: z.string(),
  origin: z.enum(['builtin', 'custom']),
  ownerSubjectId: z.string().nullable(),
  seedVersion: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  boundBy: z.array(z.string()),
});

export const AdminTraitsResponseSchema = z.object({
  traits: z.array(AdminTraitCatalogRowSchema),
});

export const AdminTraitJournalQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const AdminTraitJournalRowSchema = z.object({
  revision: z.number().int().nonnegative(),
  action: z.enum(['create', 'edit', 'rollback', 'reconcile', 'reset_to_seed', 'fork_source']),
  actor: z.enum(['owner', 'migrate']),
  payloadSchemaVersion: z.number().int().positive(),
  seedVersion: z.string().nullable(),
  sourceTraitId: z.string().nullable(),
  sourceRevision: z.number().int().nonnegative().nullable(),
  rolledBackFrom: z.number().int().nonnegative().nullable(),
  changeSeq: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export const AdminTraitJournalResponseSchema = z.object({
  data: z.array(AdminTraitJournalRowSchema),
  page: ApiPageSchema,
  journal: z.array(AdminTraitJournalRowSchema),
  next_cursor: z.string().nullable(),
});

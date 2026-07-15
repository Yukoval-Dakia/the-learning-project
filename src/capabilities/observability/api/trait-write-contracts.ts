import { z } from 'zod';

import {
  CauseTaxonomyTraitSchema,
  CharterTraitSchema,
  JudgePolicyTraitSchema,
  RenderThemeTraitSchema,
  SUBJECT_TRAIT_KINDS,
  SchedulingTraitSchema,
  SourcePolicyTraitSchema,
} from '@/subjects/trait-schemas';

const RevisionSchema = z.number().int().nonnegative();

export const AdminSubjectTraitParamsSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(SUBJECT_TRAIT_KINDS),
});

export const AdminTraitWriteParamsSchema = z.object({ id: z.string().trim().min(1) });

export const TraitPayloadSchema = z.union([
  CharterTraitSchema,
  JudgePolicyTraitSchema,
  CauseTaxonomyTraitSchema,
  SourcePolicyTraitSchema,
  RenderThemeTraitSchema,
  SchedulingTraitSchema,
]);

export const EditSubjectTraitBodySchema = z.object({
  expectedSubjectRevision: RevisionSchema,
  expectedTraitRevision: RevisionSchema,
  payload: TraitPayloadSchema,
});

export const ForkSubjectTraitBodySchema = z.object({
  expectedSubjectRevision: RevisionSchema,
});

export const RebindSubjectTraitBodySchema = z.object({
  targetTraitId: z.string().trim().min(1),
  expectedSubjectRevision: RevisionSchema,
});

export const EditAdminTraitBodySchema = z.object({
  expectedRevision: RevisionSchema,
  payload: TraitPayloadSchema,
});

export const RollbackAdminTraitBodySchema = z.object({
  expectedRevision: RevisionSchema,
  targetRevision: RevisionSchema,
});

export const ResetAdminTraitBodySchema = z.object({
  expectedRevision: RevisionSchema,
});

const TraitWriteOkResponseSchema = z.object({
  traitId: z.string(),
  revision: RevisionSchema,
  forked: z.boolean(),
});

const TraitWriteNoopResponseSchema = z.object({
  traitId: z.string(),
  revision: RevisionSchema,
  noop: z.literal(true),
});

export const TraitWriteResponseSchema = z.union([
  TraitWriteOkResponseSchema,
  TraitWriteNoopResponseSchema,
]);

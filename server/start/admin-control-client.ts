import { z } from 'zod';
import { AdminConfigResponseSchema } from '@/capabilities/observability/api/admin-config-contracts';
import { AdminConfigWriteResponseSchema } from '@/capabilities/observability/api/admin-config-write-contracts';
import {
  AdminSubjectsResponseSchema,
  AdminTraitJournalResponseSchema,
  AdminTraitsResponseSchema,
} from '@/capabilities/observability/api/subject-contracts';
import {
  AdminSubjectControlResponseSchema,
  ValidateAdminSubjectResponseSchema,
} from '@/capabilities/observability/api/subject-control-contracts';
import { TraitWriteResponseSchema } from '@/capabilities/observability/api/trait-write-contracts';
import {
  type AdminControlClient,
  SubjectTraitsWireSchema,
} from '@/capabilities/observability/ui-public';
import {
  editStartAdminSharedTrait,
  editStartAdminSubjectTrait,
  forkStartAdminSubjectTrait,
  getStartAdminConfig,
  getStartAdminSubjectTraits,
  getStartAdminSubjects,
  getStartAdminTraitJournal,
  getStartAdminTraits,
  patchStartAdminConfig,
  rebindStartAdminSubjectTrait,
  renameStartAdminSubject,
  resetStartAdminConfig,
  resetStartAdminSubject,
  resetStartAdminTraitToSeed,
  restoreStartAdminSubject,
  retireStartAdminSubject,
  rollbackStartAdminTrait,
  validateStartAdminSubject,
} from './admin-control-function';
import { authenticatedStartFetch } from './authenticated-fetch';

const transport = { fetch: authenticatedStartFetch };
const TraitReceiptSchema = z.intersection(
  TraitWriteResponseSchema,
  z.object({
    status: z.union([z.literal(200), z.literal(201)]),
    canonicalLocation: z.string().optional(),
  }),
);
export const startAdminControlClient: AdminControlClient = {
  getConfig: async () => {
    const dto = await getStartAdminConfig(transport);
    return AdminConfigResponseSchema.parse(JSON.parse(dto));
  },
  patchConfig: async (input) => {
    const dto = await patchStartAdminConfig({ ...transport, data: input });
    AdminConfigWriteResponseSchema.parse(dto);
    return dto;
  },
  resetConfig: async (input) => {
    const dto = await resetStartAdminConfig({ ...transport, data: input });
    AdminConfigWriteResponseSchema.parse(dto);
    return dto;
  },
  getSubjects: async () => {
    const dto = await getStartAdminSubjects(transport);
    AdminSubjectsResponseSchema.parse(dto);
    return dto;
  },
  getSubjectTraits: async (input) => {
    const dto = await getStartAdminSubjectTraits({ ...transport, data: input });
    return SubjectTraitsWireSchema.parse(JSON.parse(dto));
  },
  getTraits: async (input) => {
    const dto = await getStartAdminTraits({ ...transport, data: input });
    AdminTraitsResponseSchema.parse(dto);
    return dto;
  },
  getTraitJournal: async (input) => {
    const dto = await getStartAdminTraitJournal({ ...transport, data: input });
    AdminTraitJournalResponseSchema.parse(dto);
    return dto;
  },
  renameSubject: async (input) => {
    const dto = await renameStartAdminSubject({ ...transport, data: input });
    AdminSubjectControlResponseSchema.parse(dto);
    return dto;
  },
  retireSubject: async (input) => {
    const dto = await retireStartAdminSubject({ ...transport, data: input });
    AdminSubjectControlResponseSchema.parse(dto);
    return dto;
  },
  restoreSubject: async (input) => {
    const dto = await restoreStartAdminSubject({ ...transport, data: input });
    AdminSubjectControlResponseSchema.parse(dto);
    return dto;
  },
  resetSubject: async (input) => {
    const dto = await resetStartAdminSubject({ ...transport, data: input });
    AdminSubjectControlResponseSchema.parse(dto);
    return dto;
  },
  validateSubject: async (input) => {
    const dto = await validateStartAdminSubject({ ...transport, data: input });
    ValidateAdminSubjectResponseSchema.parse(dto);
    return dto;
  },
  editSubjectTrait: async (input) => {
    const dto = await editStartAdminSubjectTrait({ ...transport, data: input });
    TraitReceiptSchema.parse(dto);
    return dto;
  },
  forkSubjectTrait: async (input) => {
    const dto = await forkStartAdminSubjectTrait({ ...transport, data: input });
    TraitReceiptSchema.parse(dto);
    return dto;
  },
  rebindSubjectTrait: async (input) => {
    const dto = await rebindStartAdminSubjectTrait({ ...transport, data: input });
    TraitReceiptSchema.parse(dto);
    return dto;
  },
  editSharedTrait: async (input) => {
    const dto = await editStartAdminSharedTrait({ ...transport, data: input });
    TraitReceiptSchema.parse(dto);
    return dto;
  },
  rollbackTrait: async (input) => {
    const dto = await rollbackStartAdminTrait({ ...transport, data: input });
    TraitReceiptSchema.parse(dto);
    return dto;
  },
  resetTraitToSeed: async (input) => {
    const dto = await resetStartAdminTraitToSeed({ ...transport, data: input });
    TraitReceiptSchema.parse(dto);
    return dto;
  },
};

import { z } from 'zod';
import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import type { ApiOperationRequestBody } from '@/ui/lib/api';
import { apiFetch, apiJson, apiOperationJson } from '@/ui/lib/api';
import {
  AdminSubjectTraitsResponseSchema,
  AdminTraitBindingSchema,
} from '../api/subject-contracts';
import { TraitWriteResponseSchema } from '../api/trait-write-contracts';
import type {
  AdminSubjectCasInput,
  AdminSubjectListRow,
  AdminSubjectValidationResult,
  AdminTraitCatalogRow,
  EditSharedTraitInput,
  EditSubjectTraitInput,
  ForkSubjectTraitInput,
  RebindSubjectTraitInput,
  RenameAdminSubjectInput,
  ResetTraitToSeedInput,
  RollbackTraitInput,
  TraitJournalRow,
  ValidateAdminSubjectInput,
} from '../public';
import type { ConfigData, ConfigReceipt, ConfigWrite } from './config-model';

// Degraded live payloads can violate a trait schema. The editor must still read
// their fields so an operator can repair them; validation stays with the writer.
export const SubjectTraitsWireSchema = AdminSubjectTraitsResponseSchema.extend({
  bindings: z.array(
    AdminTraitBindingSchema.options[0].omit({ kind: true, payload: true }).extend({
      kind: z.enum(SUBJECT_TRAIT_KINDS),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
});
export type SubjectTraitsData = z.infer<typeof SubjectTraitsWireSchema>;
export type TraitBindingRow = SubjectTraitsData['bindings'][number];
export type TraitKind = TraitBindingRow['kind'];
export type TraitJournalQuery = { traitId: string; limit?: string; cursor?: string };
export type TraitJournalData = {
  data: TraitJournalRow[];
  page: { limit: number; next_cursor: string | null };
  journal: TraitJournalRow[];
  next_cursor: string | null;
};
export type SubjectControlReceipt = { subjectRevision: number; noop?: true };
export type TraitControlReceipt = (
  | { traitId: string; revision: number; forked: boolean }
  | { traitId: string; revision: number; noop: true }
) & { status: 200 | 201; canonicalLocation?: string };

export type ValidateSubjectRequest = Omit<ValidateAdminSubjectInput, 'traitPayloadOverrides'> & {
  traitPayloadOverrides?: Partial<NonNullable<ValidateAdminSubjectInput['traitPayloadOverrides']>>;
};

export interface AdminControlClient {
  getConfig(): Promise<ConfigData>;
  patchConfig(input: ConfigWrite): Promise<ConfigReceipt>;
  resetConfig(input: ApiOperationRequestBody<'resetAdminConfig'>): Promise<ConfigReceipt>;
  getSubjects(): Promise<{ subjects: AdminSubjectListRow[] }>;
  getSubjectTraits(input: { subjectId: string }): Promise<SubjectTraitsData>;
  getTraits(input: { kind: TraitKind }): Promise<{ traits: AdminTraitCatalogRow[] }>;
  getTraitJournal(input: TraitJournalQuery): Promise<TraitJournalData>;
  renameSubject(input: RenameAdminSubjectInput): Promise<SubjectControlReceipt>;
  retireSubject(input: AdminSubjectCasInput): Promise<SubjectControlReceipt>;
  restoreSubject(input: AdminSubjectCasInput): Promise<SubjectControlReceipt>;
  resetSubject(input: AdminSubjectCasInput): Promise<SubjectControlReceipt>;
  validateSubject(input: ValidateSubjectRequest): Promise<AdminSubjectValidationResult>;
  editSubjectTrait(input: EditSubjectTraitInput): Promise<TraitControlReceipt>;
  forkSubjectTrait(input: ForkSubjectTraitInput): Promise<TraitControlReceipt>;
  rebindSubjectTrait(input: RebindSubjectTraitInput): Promise<TraitControlReceipt>;
  editSharedTrait(input: EditSharedTraitInput): Promise<TraitControlReceipt>;
  rollbackTrait(input: RollbackTraitInput): Promise<TraitControlReceipt>;
  resetTraitToSeed(input: ResetTraitToSeedInput): Promise<TraitControlReceipt>;
}

const subjectPath = (id: string) => `/api/admin/subjects/${encodeURIComponent(id)}`;
const traitPath = (id: string) => `/api/admin/traits/${encodeURIComponent(id)}`;
const write = <T>(url: string, method: string, body: unknown): Promise<T> =>
  apiJson(url, { method, body: JSON.stringify(body) });
async function writeTrait(
  url: string,
  method: string,
  body: unknown,
): Promise<TraitControlReceipt> {
  const response = await apiFetch(url, { method, body: JSON.stringify(body) });
  const receipt = TraitWriteResponseSchema.parse(await response.json());
  const location = response.headers.get('Location');
  return {
    ...receipt,
    status: response.status === 201 ? 201 : 200,
    ...(location ? { canonicalLocation: location } : {}),
  };
}

// Development and retained SPA consumers continue to use the existing HTTP API.
export const httpAdminControlClient: AdminControlClient = {
  getConfig: () => apiOperationJson('getAdminConfig', { url: '/api/admin/config', method: 'GET' }),
  patchConfig: (body) =>
    apiOperationJson('writeAdminConfig', { url: '/api/admin/config', method: 'PATCH', body }),
  resetConfig: (body) =>
    apiOperationJson('resetAdminConfig', { url: '/api/admin/config/reset', method: 'POST', body }),
  getSubjects: () => apiJson('/api/admin/subjects'),
  getSubjectTraits: ({ subjectId }) => apiJson(`${subjectPath(subjectId)}/traits`),
  getTraits: ({ kind }) => apiJson(`/api/admin/traits?kind=${kind}`),
  getTraitJournal: ({ traitId, limit, cursor }) => {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('limit', limit);
    if (cursor !== undefined) query.set('cursor', cursor);
    return apiJson(`${traitPath(traitId)}/journal${query.size ? `?${query}` : ''}`);
  },
  renameSubject: ({ subjectId, ...body }) => write(subjectPath(subjectId), 'PATCH', body),
  retireSubject: ({ subjectId, ...body }) =>
    write(`${subjectPath(subjectId)}/retire`, 'POST', body),
  restoreSubject: ({ subjectId, ...body }) =>
    write(`${subjectPath(subjectId)}/restore`, 'POST', body),
  resetSubject: ({ subjectId, ...body }) => write(`${subjectPath(subjectId)}/reset`, 'POST', body),
  validateSubject: ({ subjectId, ...body }) =>
    write(`${subjectPath(subjectId)}/validate`, 'POST', body),
  editSubjectTrait: ({ subjectId, kind, ...body }) =>
    writeTrait(`${subjectPath(subjectId)}/traits/${kind}`, 'PUT', body),
  forkSubjectTrait: ({ subjectId, kind, ...body }) =>
    writeTrait(`${subjectPath(subjectId)}/traits/${kind}/fork`, 'POST', body),
  rebindSubjectTrait: ({ subjectId, kind, ...body }) =>
    writeTrait(`${subjectPath(subjectId)}/traits/${kind}/binding`, 'PUT', body),
  editSharedTrait: ({ traitId, ...body }) => writeTrait(traitPath(traitId), 'PUT', body),
  rollbackTrait: ({ traitId, ...body }) =>
    writeTrait(`${traitPath(traitId)}/rollback`, 'POST', body),
  resetTraitToSeed: ({ traitId, ...body }) =>
    writeTrait(`${traitPath(traitId)}/reset-to-seed`, 'POST', body),
};

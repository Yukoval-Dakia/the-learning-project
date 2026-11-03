// Read side of model admission: the active slices plus the group→subject bridge the
// issuance gate needs. Writing and retiring slices belongs to Practice grading.
// The live model pins come from the pin table Practice installs at startup.

import { eq, inArray } from 'drizzle-orm';
import type {
  AdmittedModelSliceT,
  ModelAdmissionContext,
} from '@/core/schema/assessment/serving-admission';
import type { Db, Tx } from '@/db/client';
import { model_admission_slice, question } from '@/db/schema';
import { batchResolveEffectiveDomains } from '@/kernel/read-models/knowledge-tree';
import { resolveSubjectProfile } from '@/subjects/profile';

type SliceRow = typeof model_admission_slice.$inferSelect;

export type ModelPins = ReadonlyMap<string, { model: string; model_version: string }>;

let readPins: (() => ModelPins) | undefined;

export function installModelPinReader(reader: () => ModelPins): void {
  readPins = reader;
}

const NO_PINS: ModelPins = new Map();

// Pins are only compared against an active slice. Without one the serving decision does not
// read them, so a host or DB test that admitted no slice needs no reader; with one, fail loudly.
function readModelPins(hasActiveSlice: boolean): ModelPins {
  if (readPins) return readPins();
  if (!hasActiveSlice) return NO_PINS;
  throw new Error(
    'model pin reader is not installed; call installModelAdmissionPins before reading model admission',
  );
}

export function admittedSliceFromRow(row: SliceRow): AdmittedModelSliceT {
  return {
    slice_id: row.slice_id,
    subject: row.subject,
    response_class: row.response_class,
    task_kind: row.task_kind,
    model: row.model,
    model_version: row.model_version,
    holdout_evidence_ref: row.holdout_evidence_ref,
    admitted_at: row.admitted_at.toISOString(),
    admitted_by: row.admitted_by,
  };
}

/** Active slices plus the current pins. Read only. */
export async function resolveModelAdmissionContext(db: Db | Tx): Promise<ModelAdmissionContext> {
  const rows = await db
    .select()
    .from(model_admission_slice)
    .where(eq(model_admission_slice.status, 'active'));
  return {
    slices: new Map(rows.map((row) => [row.slice_id, admittedSliceFromRow(row)])),
    current_models: readModelPins(rows.length > 0),
  };
}

/** Same bridge as the holdout job: first knowledge id, then effective domain, then subject. */
export type GroupSubjectLookup =
  | { readonly kind: 'subject'; readonly subject: string }
  | { readonly kind: 'missing_group' }
  | { readonly kind: 'unlabeled' }
  | { readonly kind: 'no_domain'; readonly knowledge_id: string };

export async function lookupGroupSubjects(
  db: Db | Tx,
  groupIds: readonly string[],
): Promise<Map<string, GroupSubjectLookup>> {
  const unique = [...new Set(groupIds)];
  const out = new Map<string, GroupSubjectLookup>();
  if (unique.length === 0) return out;
  const rows = await db
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(inArray(question.id, unique));
  const knowledgeByGroup = new Map(rows.map((row) => [row.id, row.knowledge_ids[0] ?? null]));
  const domains = await batchResolveEffectiveDomains(db, [
    ...new Set([...knowledgeByGroup.values()].filter((id): id is string => id !== null)),
  ]);
  for (const groupId of unique) {
    if (!knowledgeByGroup.has(groupId)) {
      out.set(groupId, { kind: 'missing_group' });
      continue;
    }
    const knowledgeId = knowledgeByGroup.get(groupId) ?? null;
    if (knowledgeId === null) {
      out.set(groupId, { kind: 'unlabeled' });
      continue;
    }
    const domain = domains.get(knowledgeId) ?? null;
    if (domain === null) {
      out.set(groupId, { kind: 'no_domain', knowledge_id: knowledgeId });
      continue;
    }
    out.set(groupId, { kind: 'subject', subject: resolveSubjectProfile(domain).id });
  }
  return out;
}

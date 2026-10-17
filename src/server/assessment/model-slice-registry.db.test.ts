import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import { model_admission_slice } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  ModelSliceRegistrationError,
  assertModelAdmissionSliceRegistrable,
  currentModelPins,
  modelSliceIdFor,
  registerModelAdmissionSlice,
  retireModelAdmissionSlice,
} from './model-slice-registry';

const pin = () => {
  const current = currentModelPins().get('JevScoringDecisionTask');
  if (current === undefined) throw new Error('Jev pin missing');
  return current;
};

function input(evidence: string) {
  const current = pin();
  return {
    subject: 'math',
    response_class: 'blank' as const,
    task_kind: 'JevScoringDecisionTask',
    model: current.model,
    model_version: current.model_version,
    holdout_evidence_ref: evidence,
    admitted_by: 'owner',
    admitted_at: new Date('2026-10-17T00:00:00.000Z'),
  };
}

describe('model admission slice identity', () => {
  beforeEach(resetDb);

  // @invariant grading: the stored slice id is the five-field natural key, so a question citing the reported id resolves
  // @fails-if hash the registration payload (evidence, actor, or admitted_at) into the slice id; the stored id diverges from modelSliceIdFor of the five fields
  it('stores the five-field slice id even when the registration carries evidence and an actor', async () => {
    const db = testDb();
    const registration = input('evt_holdout_a');
    const stored = await registerModelAdmissionSlice(db, registration);
    const fiveFields = {
      subject: registration.subject,
      response_class: registration.response_class,
      task_kind: registration.task_kind,
      model: registration.model,
      model_version: registration.model_version,
    };
    expect(stored.slice_id).toBe(modelSliceIdFor(fiveFields));
    expect(stored.slice_id).not.toBe(`slice_${canonicalHash(registration).slice(0, 32)}`);
    const [row] = await db.select().from(model_admission_slice);
    expect(row?.slice_id).toBe(stored.slice_id);
  });

  // @invariant idempotency: registering an existing pin with different evidence is a coded refusal, including a row whose slice_id was not the five-field hash
  // @fails-if look up only by slice_id or let the natural-key unique index surface as a raw 23505; the second register throws ModelSliceRegistrationError slice_conflict
  it('refuses a second registration of the same pin with different evidence', async () => {
    const db = testDb();
    const first = input('evt_holdout_a');
    await registerModelAdmissionSlice(db, first);
    const conflict = registerModelAdmissionSlice(db, input('evt_holdout_b'));
    await expect(conflict).rejects.toBeInstanceOf(ModelSliceRegistrationError);
    await expect(conflict).rejects.toMatchObject({ code: 'slice_conflict' });

    const current = pin();
    await db.insert(model_admission_slice).values({
      slice_id: 'slice_legacy_wrong',
      subject: 'physics',
      response_class: 'free',
      task_kind: 'JevScoringDecisionTask',
      model: current.model,
      model_version: current.model_version,
      holdout_evidence_ref: 'evt_legacy',
      admitted_by: 'owner',
      admitted_at: new Date('2026-10-17T00:00:00.000Z'),
      status: 'active',
    });
    const legacy = {
      subject: 'physics',
      response_class: 'free' as const,
      task_kind: 'JevScoringDecisionTask',
      model: current.model,
      model_version: current.model_version,
      holdout_evidence_ref: 'evt_other',
      admitted_by: 'owner',
    };
    await expect(assertModelAdmissionSliceRegistrable(db, legacy)).rejects.toMatchObject({
      code: 'slice_conflict',
    });
    await expect(registerModelAdmissionSlice(db, legacy)).rejects.toMatchObject({
      code: 'slice_conflict',
    });
  });

  // @invariant grading: a retired natural key stays retired; both the pre-check and the register path say so
  // @fails-if promise that a fresh holdout can rewrite the retired row, or miss the row and insert a second one
  it('refuses to resurrect a retired slice from either entry', async () => {
    const db = testDb();
    const registration = input('evt_holdout_a');
    const stored = await registerModelAdmissionSlice(db, registration);
    expect(await retireModelAdmissionSlice(db, stored.slice_id)).toBe('retired');
    await expect(assertModelAdmissionSliceRegistrable(db, registration)).rejects.toMatchObject({
      code: 'slice_retired',
    });
    await expect(registerModelAdmissionSlice(db, registration)).rejects.toThrow(
      /retirement is permanent/,
    );
  });
});

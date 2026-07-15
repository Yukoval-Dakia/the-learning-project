import { beforeEach, describe, expect, it } from 'vitest';

import { subject_trait } from '@/db/schema';
import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { thinCreateSubject } from '@/server/subjects/thin-create';
import { eq } from 'drizzle-orm';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { BINDING, FORK, PUT as PUT_SUBJECT_TRAIT } from './admin-subject-trait-write';
import { GET as getTraitJournal } from './admin-trait-journal';
import { PUT as PUT_TRAIT, RESET_TO_SEED, ROLLBACK } from './admin-trait-write';
import { TraitWriteResponseSchema } from './trait-write-contracts';

const db = testDb();

async function traitRow(id: string) {
  const rows = await db.select().from(subject_trait).where(eq(subject_trait.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`trait ${id} not found`);
  return row;
}

function jsonRequest(url: string, method: 'POST' | 'PUT', body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('admin trait write route contracts', () => {
  beforeEach(async () => {
    await resetDb();
    await reconcileBuiltinTraits(db);
    await hydrateSubjectRegistryFromDb(db);
  });

  it('returns 201 with a readable trait-journal Location', async () => {
    const subject = await thinCreateSubject(db, '化学');
    expect(subject.kind).toBe('created');
    if (subject.kind !== 'created') return;

    const response = await FORK(
      new Request(`http://localhost/api/admin/subjects/${subject.payload.id}/traits/charter/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedSubjectRevision: 0 }),
      }),
      { id: subject.payload.id, kind: 'charter' },
    );

    expect(response.status).toBe(201);
    const body = TraitWriteResponseSchema.parse(await response.json());
    const location = `/api/admin/traits/${body.traitId}/journal`;
    expect(response.headers.get('Location')).toBe(location);

    const detail = await getTraitJournal(new Request(`http://localhost${location}`), {
      id: body.traitId,
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: [{ revision: 0, action: 'fork_source' }],
    });
  });

  it('validates subject edit and binding success responses', async () => {
    const subject = await thinCreateSubject(db, '化学');
    if (subject.kind !== 'created') throw new Error(`thin-create failed: ${subject.kind}`);
    const seed = await traitRow('trt_seed_general_charter');

    const edited = await PUT_SUBJECT_TRAIT(
      jsonRequest(
        `http://localhost/api/admin/subjects/${subject.payload.id}/traits/charter`,
        'PUT',
        {
          expectedSubjectRevision: 0,
          expectedTraitRevision: seed.revision,
          payload: { ...(seed.payload as Record<string, unknown>), methodology: '先讲原理' },
        },
      ),
      { id: subject.payload.id, kind: 'charter' },
    );
    expect(edited.status).toBe(201);
    expect(TraitWriteResponseSchema.parse(await edited.json())).toMatchObject({ forked: true });

    const rebound = await BINDING(
      jsonRequest(
        `http://localhost/api/admin/subjects/${subject.payload.id}/traits/charter/binding`,
        'PUT',
        { targetTraitId: seed.id, expectedSubjectRevision: 1 },
      ),
      { id: subject.payload.id, kind: 'charter' },
    );
    expect(rebound.status).toBe(200);
    expect(TraitWriteResponseSchema.parse(await rebound.json())).toMatchObject({
      traitId: seed.id,
    });
  });

  it('validates direct edit, rollback, and reset-to-seed responses', async () => {
    const seed = await traitRow('trt_seed_yuwen_charter');
    const traitId = seed.id;

    const edited = await PUT_TRAIT(
      jsonRequest(`http://localhost/api/admin/traits/${traitId}`, 'PUT', {
        expectedRevision: seed.revision,
        payload: { ...(seed.payload as Record<string, unknown>), methodology: '新的方法说明' },
      }),
      { id: traitId },
    );
    expect(edited.status).toBe(200);
    expect(TraitWriteResponseSchema.parse(await edited.json())).toMatchObject({ revision: 1 });

    const rolledBack = await ROLLBACK(
      jsonRequest(`http://localhost/api/admin/traits/${traitId}/rollback`, 'POST', {
        expectedRevision: 1,
        targetRevision: 0,
      }),
      { id: traitId },
    );
    expect(rolledBack.status).toBe(200);
    expect(TraitWriteResponseSchema.parse(await rolledBack.json())).toMatchObject({ revision: 2 });

    const reset = await RESET_TO_SEED(
      jsonRequest(`http://localhost/api/admin/traits/${traitId}/reset-to-seed`, 'POST', {
        expectedRevision: 2,
      }),
      { id: traitId },
    );
    expect(reset.status).toBe(200);
    expect(TraitWriteResponseSchema.parse(await reset.json())).toMatchObject({ noop: true });
  });
});

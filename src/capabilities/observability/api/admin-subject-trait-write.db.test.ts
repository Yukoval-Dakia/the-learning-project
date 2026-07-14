import { beforeEach, describe, expect, it } from 'vitest';

import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { thinCreateSubject } from '@/server/subjects/thin-create';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { FORK } from './admin-subject-trait-write';
import { GET as getTraitJournal } from './admin-trait-journal';

const db = testDb();

describe('FORK /api/admin/subjects/:id/traits/:kind/fork resource contract', () => {
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
    const body = (await response.json()) as { traitId: string };
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
});

import { beforeEach, describe, expect, it } from 'vitest';

import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { getSubject } from './admin-subjects';
import { POST } from './admin-subjects-create';
import { AdminSubjectSchema, CreatedAdminSubjectResponseSchema } from './subject-contracts';

const db = testDb();

function createRequest(displayName: string): Request {
  return new Request('http://localhost/api/admin/subjects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
}

describe('POST /api/admin/subjects resource contract', () => {
  beforeEach(async () => {
    await resetDb();
    await reconcileBuiltinTraits(db);
    await hydrateSubjectRegistryFromDb(db);
  });

  it('returns 201 for create, 200 for replay, and a readable Location', async () => {
    const created = await POST(createRequest('化学'));
    expect(created.status).toBe(201);
    const body = CreatedAdminSubjectResponseSchema.parse(await created.json());
    expect(created.headers.get('Location')).toBe(`/api/admin/subjects/${body.id}`);

    const detail = await getSubject(new Request(`http://localhost/api/admin/subjects/${body.id}`), {
      id: body.id,
    });
    expect(detail.status).toBe(200);
    expect(AdminSubjectSchema.parse(await detail.json())).toMatchObject({
      id: body.id,
      displayName: '化学',
    });

    const replayed = await POST(createRequest(' 化学 '));
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get('Location')).toBe(`/api/admin/subjects/${body.id}`);
    expect(CreatedAdminSubjectResponseSchema.parse(await replayed.json())).toEqual(body);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { thinCreateSubject } from '@/server/subjects/thin-create';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { PATCH, RESET, RESTORE, RETIRE, VALIDATE } from './admin-subject-control';
import {
  AdminSubjectControlResponseSchema,
  ValidateAdminSubjectResponseSchema,
} from './subject-control-contracts';

const db = testDb();

function jsonRequest(url: string, method: 'PATCH' | 'POST', body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('admin subject control route contracts', () => {
  beforeEach(async () => {
    await resetDb();
    await reconcileBuiltinTraits(db);
    await hydrateSubjectRegistryFromDb(db);
  });

  it('validates rename, retire, restore, reset, and bodyless preflight responses', async () => {
    const created = await thinCreateSubject(db, '化学');
    if (created.kind !== 'created') throw new Error(`thin-create failed: ${created.kind}`);
    const subjectId = created.payload.id;
    const params = { id: subjectId };

    const validation = await VALIDATE(
      new Request(`http://localhost/api/admin/subjects/${subjectId}/validate`, { method: 'POST' }),
      params,
    );
    expect(validation.status).toBe(200);
    expect(ValidateAdminSubjectResponseSchema.parse(await validation.json()).valid).toBe(true);

    const invalidCandidate = await VALIDATE(
      jsonRequest(`http://localhost/api/admin/subjects/${subjectId}/validate`, 'POST', {
        traitPayloadOverrides: { charter: {} },
      }),
      params,
    );
    expect(invalidCandidate.status).toBe(200);
    expect(ValidateAdminSubjectResponseSchema.parse(await invalidCandidate.json()).valid).toBe(
      false,
    );

    const renamed = await PATCH(
      jsonRequest(`http://localhost/api/admin/subjects/${subjectId}`, 'PATCH', {
        expectedRevision: 0,
        displayName: '有机化学',
      }),
      params,
    );
    expect(renamed.status).toBe(200);
    expect(AdminSubjectControlResponseSchema.parse(await renamed.json())).toEqual({
      subjectRevision: 1,
    });

    const retired = await RETIRE(
      jsonRequest(`http://localhost/api/admin/subjects/${subjectId}/retire`, 'POST', {
        expectedRevision: 1,
      }),
      params,
    );
    expect(retired.status).toBe(200);
    expect(AdminSubjectControlResponseSchema.parse(await retired.json())).toEqual({
      subjectRevision: 2,
    });

    const restored = await RESTORE(
      jsonRequest(`http://localhost/api/admin/subjects/${subjectId}/restore`, 'POST', {
        expectedRevision: 2,
      }),
      params,
    );
    expect(restored.status).toBe(200);
    expect(AdminSubjectControlResponseSchema.parse(await restored.json())).toEqual({
      subjectRevision: 3,
    });

    const reset = await RESET(
      jsonRequest(`http://localhost/api/admin/subjects/${subjectId}/reset`, 'POST', {
        expectedRevision: 3,
      }),
      params,
    );
    expect(reset.status).toBe(200);
    expect(AdminSubjectControlResponseSchema.parse(await reset.json())).toEqual({
      subjectRevision: 3,
      noop: true,
    });
  });
});

import { knowledge } from '@/db/schema';
import { getDefaultSubjectRegistry, resolveSubjectProfile } from '@/subjects/profile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { resolveSubjectProfileForKnowledgeIdsStrict } from './subject-profile';

const CUSTOM_SUBJECT_ID = 'custom_argumentation';

describe('resolveSubjectProfileForKnowledgeIdsStrict', () => {
  beforeEach(resetDb);
  afterEach(() => {
    getDefaultSubjectRegistry().remove(CUSTOM_SUBJECT_ID);
  });

  it('rejects a real knowledge domain that is not hydrated instead of using general', async () => {
    const db = testDb();
    await db.insert(knowledge).values({
      id: 'kc_unhydrated_argumentation',
      name: '证据强度与结论方向',
      domain: CUSTOM_SUBJECT_ID,
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      updated_at: new Date('2026-08-01T00:00:00.000Z'),
    });

    await expect(
      resolveSubjectProfileForKnowledgeIdsStrict(db, ['kc_unhydrated_argumentation']),
    ).rejects.toThrow('has no hydrated subject profile');
  });

  it('resolves the exact hydrated custom profile rather than the general fallback', async () => {
    const db = testDb();
    const general = resolveSubjectProfile('general');
    const registration = getDefaultSubjectRegistry().register(
      {
        ...general,
        id: CUSTOM_SUBJECT_ID,
        displayName: '论证与证据（自定义）',
        version: 'custom-argumentation-v3',
        languageStyle: '逐项区分事实、相关、因果与结论方向。',
      },
      ['argumentation_lab'],
      {
        meta: { isBuiltin: false, isSelectable: true, retiredAt: null },
      },
    );
    expect(registration.valid).toBe(true);
    await db.insert(knowledge).values({
      id: 'kc_hydrated_argumentation',
      name: '反例、削弱与因果方向',
      domain: 'argumentation_lab',
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      updated_at: new Date('2026-08-01T00:00:00.000Z'),
    });

    const resolved = await resolveSubjectProfileForKnowledgeIdsStrict(db, [
      'kc_hydrated_argumentation',
    ]);
    expect(resolved).toMatchObject({
      id: CUSTOM_SUBJECT_ID,
      displayName: '论证与证据（自定义）',
      version: 'custom-argumentation-v3',
    });
    expect(resolved.id).not.toBe('general');
  });
});

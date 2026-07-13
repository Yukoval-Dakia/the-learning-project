import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './subjects-list';

describe('GET /api/subjects observed-domain inventory', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('includes active unknown domains and excludes archived-only domains', async () => {
    const now = new Date();
    await testDb()
      .insert(knowledge)
      .values([
        {
          id: 'active-english',
          name: 'English',
          domain: 'yingyu',
          created_at: now,
          updated_at: now,
        },
        {
          id: 'archived-history',
          name: 'History',
          domain: 'lishi',
          archived_at: now,
          created_at: now,
          updated_at: now,
        },
      ]);

    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      subjects: Array<{ id: string; configurationStatus: string }>;
    };
    expect(body.subjects).toContainEqual(
      expect.objectContaining({ id: 'yingyu', configurationStatus: 'unconfigured' }),
    );
    expect(body.subjects.some((subject) => subject.id === 'lishi')).toBe(false);
  });
});

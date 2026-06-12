import { describe, expect, it } from 'vitest';

import { GET } from '@/capabilities/observability/api/admin-subjects';

describe('GET /api/admin/subjects', () => {
  it('返回 slim 投影（R11：不暴露 promptFragments / noteTemplate / causeCategories）', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subjects: Record<string, unknown>[] };
    expect(body.subjects.length).toBeGreaterThan(0);
    for (const row of body.subjects) {
      expect(Object.keys(row).sort()).toEqual([
        'capabilityCount',
        'displayName',
        'id',
        'notation',
        'version',
      ]);
    }
  });
});

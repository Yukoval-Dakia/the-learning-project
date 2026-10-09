import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getKnowledgeTree } from '@/capabilities/knowledge/api/tree';
import { loadTreeSnapshot } from '@/capabilities/knowledge/public';
import { knowledge, mastery_state } from '@/db/schema';
import { resetDb, testDb } from '../../tests/helpers/db';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartWorkbench } from './workbench-read';
import { readStartKnowledgeTree } from './workbench-reader';

// Replace only connection ownership. The snapshot, SQL and postgres-js decoder
// are real, and both the retained HTTP endpoint and Start read the isolated DB.
vi.mock('@/db/client', async () => {
  const { testDb } = await import('../../tests/helpers/db');
  return {
    get db() {
      return testDb();
    },
  };
});

beforeEach(async () => {
  vi.stubEnv('INTERNAL_TOKEN', 'isolated-timestamp-token');
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

describe('Start knowledge tree real-driver timestamp regression', () => {
  it('preserves nonempty snapshot raw timestamp precision and retained HTTP JSON', async () => {
    const db = testDb();
    const updatedAt = new Date('2026-10-08T02:00:00.000Z');
    const createdAt = sql`'2026-10-08 01:02:03.123456+08'::timestamptz`;
    await db.insert(knowledge).values([
      {
        id: 'kc-timestamp-parent',
        name: '真实驱动与精度'.repeat(40),
        domain: 'math',
        created_at: createdAt,
        updated_at: updatedAt,
      },
      {
        id: 'kc-timestamp-child',
        name: '继承科目',
        parent_id: 'kc-timestamp-parent',
        created_at: createdAt,
        updated_at: updatedAt,
      },
      {
        id: 'synthetic:timestamp-hidden',
        name: '隐藏种子',
        domain: 'math',
        created_at: createdAt,
        updated_at: updatedAt,
      },
      {
        id: 'kc-timestamp-archived',
        name: '已归档',
        archived_at: updatedAt,
        created_at: createdAt,
        updated_at: updatedAt,
      },
    ]);
    await db.insert(mastery_state).values({
      id: 'mastery-timestamp-parent',
      subject_id: 'kc-timestamp-parent',
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      last_outcome_at: new Date('2026-10-07T23:45:06.789+08:00'),
    });

    const snapshot = await loadTreeSnapshot(db);
    expect(snapshot).toHaveLength(3);
    const parent = snapshot.find((row) => row.id === 'kc-timestamp-parent');
    if (!parent) throw new Error('expected nonempty visible knowledge snapshot');
    // sql<Date> is a static annotation, not a runtime decoder.
    const rawTimestamp: unknown = parent.last_active_at;
    expect(typeof rawTimestamp).toBe('string');
    if (typeof rawTimestamp !== 'string') throw new Error('expected raw postgres-js timestamp');
    expect(rawTimestamp).toMatch(/\.123456[+-]/);
    expect(Date.parse(rawTimestamp)).toBe(new Date('2026-10-07T17:02:03.123Z').getTime());
    expect(parent.last_evidence_at).toBeInstanceOf(Date);

    const context = { api: buildHonoApp([], { epochGate: async () => ({ runnable: true }) }) };
    const request = new Request('http://isolated.test/_serverFn/knowledge-tree', {
      headers: { 'x-internal-token': 'isolated-timestamp-token' },
    });
    const result = await runAuthenticatedStartWorkbench(context, request, readStartKnowledgeTree);
    const http = await getKnowledgeTree();
    expect(http.status).toBe(200);
    expect(result).toEqual(await http.json());
    expect(result.rows.map((row) => row.id)).toEqual(['kc-timestamp-child', 'kc-timestamp-parent']);
    expect(result.rows.find((row) => row.id === parent.id)).toMatchObject({
      last_active_at: rawTimestamp,
      last_evidence_at: '2026-10-07T15:45:06.789Z',
      archived_at: null,
      evidence_count: 3,
    });
    expect(result.rows.find((row) => row.id === 'kc-timestamp-child')).toMatchObject({
      effective_domain: 'math',
      last_active_at: rawTimestamp,
      last_evidence_at: null,
      archived_at: null,
    });
  });
});

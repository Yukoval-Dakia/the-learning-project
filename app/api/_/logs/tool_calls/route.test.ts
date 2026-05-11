import { tool_call_log } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { GET } from './route';

const db = testDb();

describe('GET /api/_/logs/tool_calls', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns recent tool call rows ordered by occurred_at desc', async () => {
    await db.insert(tool_call_log).values([
      {
        id: 'tcl_older',
        task_run_id: 'tr_1',
        task_kind: 'AttributionTask',
        tool_name: 'search_knowledge',
        iteration: 1,
        latency_ms: 100,
        cost: 0.001,
        occurred_at: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'tcl_newer',
        task_run_id: 'tr_2',
        task_kind: 'AttributionTask',
        tool_name: 'fetch_context',
        iteration: 2,
        latency_ms: 200,
        cost: 0.002,
        occurred_at: new Date('2026-01-02T00:00:00Z'),
      },
    ]);

    const req = new Request('http://localhost/api/_/logs/tool_calls');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[]; limit: number };
    expect(body.items).toHaveLength(2);
    // newest first
    expect(body.items[0].id).toBe('tcl_newer');
    expect(body.items[1].id).toBe('tcl_older');
    expect(body.limit).toBe(50);
  });

  it('respects limit param', async () => {
    await db.insert(tool_call_log).values(
      Array.from({ length: 5 }, (_, i) => ({
        id: `tcl_${i}`,
        task_run_id: 'tr_1',
        task_kind: 'SomeTask',
        tool_name: 'tool',
        iteration: i,
        latency_ms: 10,
        cost: 0.001,
        occurred_at: new Date(`2026-01-0${i + 1}T00:00:00Z`),
      })),
    );

    const req = new Request('http://localhost/api/_/logs/tool_calls?limit=2');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  it('clamps limit above 200 to 200', async () => {
    const req = new Request('http://localhost/api/_/logs/tool_calls?limit=99999');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { limit: number };
    expect(body.limit).toBe(200);
  });

  it('defaults to limit 50 when limit param is absent or invalid', async () => {
    const req = new Request('http://localhost/api/_/logs/tool_calls?limit=banana');
    const res = await GET(req);
    const body = (await res.json()) as { limit: number };
    expect(body.limit).toBe(50);
  });

  it('filters by task_kind when provided', async () => {
    await db.insert(tool_call_log).values([
      {
        id: 'tcl_a',
        task_run_id: 'tr_1',
        task_kind: 'AttributionTask',
        tool_name: 'tool_a',
        iteration: 1,
        latency_ms: 10,
        cost: 0.001,
        occurred_at: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'tcl_b',
        task_run_id: 'tr_2',
        task_kind: 'OtherTask',
        tool_name: 'tool_b',
        iteration: 1,
        latency_ms: 10,
        cost: 0.001,
        occurred_at: new Date('2026-01-02T00:00:00Z'),
      },
    ]);

    const req = new Request('http://localhost/api/_/logs/tool_calls?task_kind=AttributionTask');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { task_kind: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].task_kind).toBe('AttributionTask');
  });
});

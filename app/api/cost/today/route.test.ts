// Phase 1d — /api/cost/today summary for the /today ribbon.

import { cost_ledger, tool_call_log } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

async function fetchSummary(): Promise<Response> {
  return GET(new Request('http://localhost/api/cost/today'));
}

describe('GET /api/cost/today', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns zeros when no cost rows exist', async () => {
    const res = await fetchSummary();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      today: {
        spend: number;
        tokens_in: number;
        tokens_out: number;
        ledger_rows: number;
        tool_calls: number;
        by_task: unknown[];
      };
    };
    expect(body.today.spend).toBe(0);
    expect(body.today.tokens_in).toBe(0);
    expect(body.today.ledger_rows).toBe(0);
    expect(body.today.tool_calls).toBe(0);
    expect(body.today.by_task).toEqual([]);
  });

  it('sums spend + tokens + groups by_task across today', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(cost_ledger).values([
      {
        id: 'c1',
        task_kind: 'AttributionTask',
        provider: 'anthropic',
        model: 'sonnet',
        cost: 0.012,
        tokens_in: 100,
        tokens_out: 50,
        outcome: 'success',
        pgboss_job_id: null,
        occurred_at: now,
      },
      {
        id: 'c2',
        task_kind: 'AttributionTask',
        provider: 'anthropic',
        model: 'sonnet',
        cost: 0.008,
        tokens_in: 60,
        tokens_out: 40,
        outcome: 'success',
        pgboss_job_id: null,
        occurred_at: now,
      },
      {
        id: 'c3',
        task_kind: 'KnowledgeProposeTask',
        provider: 'anthropic',
        model: 'sonnet',
        cost: 0.003,
        tokens_in: 30,
        tokens_out: 20,
        outcome: 'success',
        pgboss_job_id: null,
        occurred_at: now,
      },
    ]);
    await db.insert(tool_call_log).values({
      id: 't1',
      task_run_id: 'tr1',
      task_kind: 'AttributionTask',
      tool_name: 'extract',
      input_json: {},
      output_json: {},
      iteration: 0,
      latency_ms: 12,
      cost: 0.001,
      occurred_at: now,
    });

    const res = await fetchSummary();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      today: {
        spend: number;
        tokens_in: number;
        tokens_out: number;
        ledger_rows: number;
        tool_calls: number;
        by_task: Array<{ task_kind: string; spend: number; calls: number }>;
      };
    };
    expect(body.today.ledger_rows).toBe(3);
    expect(body.today.tool_calls).toBe(1);
    expect(body.today.spend).toBeCloseTo(0.023, 5);
    expect(body.today.tokens_in).toBe(190);
    expect(body.today.tokens_out).toBe(110);

    const byTask = Object.fromEntries(
      body.today.by_task.map((t) => [t.task_kind, { spend: t.spend, calls: t.calls }]),
    );
    expect(byTask.AttributionTask.calls).toBe(2);
    expect(byTask.AttributionTask.spend).toBeCloseTo(0.02, 5);
    expect(byTask.KnowledgeProposeTask.calls).toBe(1);
  });

  it('excludes rows older than BJT midnight', async () => {
    const db = testDb();
    const old = new Date('2020-01-01T00:00:00Z');
    await db.insert(cost_ledger).values({
      id: 'old',
      task_kind: 'AttributionTask',
      provider: 'anthropic',
      model: 'sonnet',
      cost: 99,
      tokens_in: 0,
      tokens_out: 0,
      outcome: 'success',
      pgboss_job_id: null,
      occurred_at: old,
    });

    const res = await fetchSummary();
    const body = (await res.json()) as { today: { spend: number } };
    expect(body.today.spend).toBe(0);
  });
});

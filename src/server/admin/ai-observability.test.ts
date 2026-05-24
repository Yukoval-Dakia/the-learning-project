import { ai_task_runs, cost_ledger, tool_call_log } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  getAdminCost,
  getAdminFailureClusters,
  getAdminRunTimeline,
  listAdminRuns,
  listAdminRunsPage,
} from './ai-observability';

const db = testDb();
const BASE = new Date('2026-05-23T08:00:00Z');

function at(minutes: number): Date {
  return new Date(BASE.getTime() + minutes * 60_000);
}

async function seedRun(opts: Partial<typeof ai_task_runs.$inferInsert> & { id: string }) {
  await db.insert(ai_task_runs).values({
    task_kind: 'AttributionTask',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    input_hash: `hash_${opts.id}`,
    status: 'success',
    finish_reason: 'stop',
    usage_json: { inputTokens: 100, outputTokens: 20 },
    cost_usd: 0.01,
    error_message: null,
    started_at: BASE,
    finished_at: at(1),
    ...opts,
  });
}

async function seedCost(opts: Partial<typeof cost_ledger.$inferInsert> & { id: string }) {
  await db.insert(cost_ledger).values({
    task_run_id: 'run_1',
    task_kind: 'AttributionTask',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    cost: 0.01,
    tokens_in: 100,
    tokens_out: 20,
    outcome: 'success',
    pgboss_job_id: 'job_1',
    occurred_at: at(1),
    ...opts,
  });
}

async function seedTool(opts: Partial<typeof tool_call_log.$inferInsert> & { id: string }) {
  await db.insert(tool_call_log).values({
    task_run_id: 'run_1',
    task_kind: 'AttributionTask',
    tool_name: 'query_mistakes',
    input_json: { limit: 5 },
    output_json: { rows: [] },
    iteration: 1,
    latency_ms: 125,
    cost: 0.001,
    occurred_at: at(0.5),
    ...opts,
  });
}

describe('AI observability admin read model', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('lists runs with ledger cost, pg-boss job ids, and tool-call counts', async () => {
    await seedRun({ id: 'run_1' });
    await seedCost({ id: 'cost_1', cost: 0.02, pgboss_job_id: 'job_alpha' });
    await seedTool({ id: 'tool_1' });
    await seedTool({ id: 'tool_2', iteration: 2, occurred_at: at(0.75) });

    const rows = await listAdminRuns(db);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'run_1',
      task_kind: 'AttributionTask',
      ledger_cost_usd: 0.02,
      ledger_rows: 1,
      tool_call_count: 2,
      pgboss_job_ids: ['job_alpha'],
    });
    expect(rows[0].duration_ms).toBe(60_000);
  });

  it('returns run list limit metadata for truncated admin views', async () => {
    await seedRun({ id: 'run_1', started_at: at(1) });
    await seedRun({ id: 'run_2', started_at: at(2) });
    await seedRun({ id: 'run_3', started_at: at(3) });

    const page = await listAdminRunsPage(db, { limit: 2 });

    expect(page.rows.map((row) => row.id)).toEqual(['run_3', 'run_2']);
    expect(page).toMatchObject({
      limit: 2,
      total: 3,
      truncated: true,
    });
  });

  it('returns a single run timeline with pg-boss job id and tool calls in time order', async () => {
    await seedRun({ id: 'run_1', finished_at: at(3), cost_usd: 0.031 });
    await seedCost({ id: 'cost_1', occurred_at: at(2), pgboss_job_id: 'job_alpha' });
    await seedTool({ id: 'tool_1', occurred_at: at(1), tool_name: 'query_events' });

    const detail = await getAdminRunTimeline(db, 'run_1');

    expect(detail?.run.pgboss_job_ids).toEqual(['job_alpha']);
    expect(detail?.ledger).toHaveLength(1);
    expect(detail?.tool_calls).toHaveLength(1);
    expect(detail?.timeline.map((event) => event.type)).toEqual([
      'run_started',
      'tool_call',
      'cost_ledger',
      'run_finished',
    ]);
    expect(detail?.timeline.find((event) => event.type === 'cost_ledger')).toMatchObject({
      pgboss_job_id: 'job_alpha',
      cost: 0.01,
    });
  });

  it('sorts same-timestamp timeline events by id for stable refresh order', async () => {
    await seedRun({ id: 'run_1', finished_at: at(2) });
    await seedTool({ id: 'a_tool', occurred_at: at(1), tool_name: 'query_events' });
    await seedCost({ id: 'z_cost', occurred_at: at(1), pgboss_job_id: 'job_alpha' });

    const detail = await getAdminRunTimeline(db, 'run_1');

    expect(detail?.timeline.map((event) => event.id)).toEqual([
      'run_1',
      'a_tool',
      'z_cost',
      'run_1',
    ]);
  });

  it('aggregates cost by day and task kind', async () => {
    await seedCost({
      id: 'cost_a1',
      task_run_id: 'run_a',
      task_kind: 'AttributionTask',
      cost: 0.01,
      tokens_in: 100,
      tokens_out: 10,
      occurred_at: new Date(),
    });
    await seedCost({
      id: 'cost_a2',
      task_run_id: 'run_a',
      task_kind: 'AttributionTask',
      cost: 0.02,
      tokens_in: 200,
      tokens_out: 20,
      occurred_at: new Date(),
    });
    await seedCost({
      id: 'cost_b1',
      task_run_id: 'run_b',
      task_kind: 'KnowledgeReviewTask',
      cost: 0.03,
      tokens_in: 300,
      tokens_out: 30,
      occurred_at: new Date(),
    });

    const cost = await getAdminCost(db, { days: 7 });

    expect(cost.days_window).toBe(7);
    expect(cost.days).toHaveLength(1);
    expect(cost.days[0].cost).toBeCloseTo(0.06);
    expect(cost.days[0].calls).toBe(3);
    expect(cost.by_task).toEqual([
      expect.objectContaining({ task_kind: 'AttributionTask', cost: expect.closeTo(0.03, 5) }),
      expect.objectContaining({ task_kind: 'KnowledgeReviewTask', cost: expect.closeTo(0.03, 5) }),
    ]);
  });

  it('normalizes invalid cost windows to the default', async () => {
    const cost = await getAdminCost(db, { days: Number.NaN });

    expect(cost.days_window).toBe(30);
    expect(cost.days).toEqual([]);
  });

  it('clusters failure samples by finish reason and error message prefix', async () => {
    await seedRun({
      id: 'fail_1',
      status: 'failure',
      finish_reason: 'error',
      error_message: 'Provider timeout after 30s while calling model',
      started_at: at(1),
    });
    await seedRun({
      id: 'fail_2',
      status: 'failure',
      finish_reason: 'error',
      error_message: 'Provider timeout after 30s while calling model',
      started_at: at(2),
    });
    await seedRun({
      id: 'fail_3',
      task_kind: 'KnowledgeReviewTask',
      status: 'failure',
      finish_reason: 'tool_error',
      error_message: 'Tool returned invalid proposal payload',
      started_at: at(3),
    });
    await seedRun({
      id: 'ok_1',
      status: 'success',
      finish_reason: 'stop',
      error_message: null,
      started_at: at(4),
    });

    const clusters = await getAdminFailureClusters(db);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({
      finish_reason: 'error',
      error_prefix: 'Provider timeout after 30s while calling model',
      count: 2,
    });
    expect(clusters[0].samples.map((sample) => sample.id)).toEqual(['fail_2', 'fail_1']);
    expect(clusters[1]).toMatchObject({
      finish_reason: 'tool_error',
      count: 1,
    });
  });
});

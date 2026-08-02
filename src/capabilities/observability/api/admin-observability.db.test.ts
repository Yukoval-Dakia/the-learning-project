import { ai_task_runs, cost_ledger, tool_call_log } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET as getAdminCost } from './admin-cost';
import { GET as getAdminFailures } from './admin-failures';
import {
  AdminCostResponseSchema,
  AdminFailuresResponseSchema,
  AdminRunDetailResponseSchema,
  AdminRunsResponseSchema,
  CostTodayResponseSchema,
} from './admin-observability-contracts';
import { GET as getAdminRun } from './admin-run-detail';
import { GET as getAdminRuns } from './admin-runs';
import { GET as getTodayCost } from './cost-today';

const db = testDb();

async function seedObservabilityRows(status: 'success' | 'failure' = 'success') {
  const now = new Date();
  await db.insert(ai_task_runs).values({
    id: 'run_contract',
    task_kind: 'ContractTask',
    provider: 'test',
    model: 'test-model',
    input_hash: 'contract-hash',
    status,
    finish_reason: status === 'failure' ? 'error' : 'stop',
    usage_json: { inputTokens: 12, outputTokens: 3 },
    cost_usd: 0.25,
    error_message: status === 'failure' ? 'contract failure' : null,
    started_at: new Date(now.getTime() - 1000),
    finished_at: now,
  });
  await db.insert(cost_ledger).values({
    id: 'cost_contract',
    task_run_id: 'run_contract',
    task_kind: 'ContractTask',
    provider: 'test',
    model: 'test-model',
    cost: 0.25,
    currency: 'USD',
    tokens_in: 12,
    tokens_out: 3,
    outcome: status,
    pgboss_job_id: 'job_contract',
    occurred_at: now,
  });
  await db.insert(tool_call_log).values({
    id: 'tool_contract',
    task_run_id: 'run_contract',
    task_kind: 'ContractTask',
    tool_name: 'contract_tool',
    input_json: { value: 1 },
    output_json: { ok: true },
    iteration: 1,
    latency_ms: 10,
    cost: 0,
    occurred_at: now,
  });
}

describe('AI observability route contracts', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('matches the run collection and detail response schemas', async () => {
    await seedObservabilityRows();

    const listResponse = await getAdminRuns(
      new Request('http://localhost/api/admin/runs?limit=1&status=success'),
    );
    expect(listResponse.status).toBe(200);
    const list = AdminRunsResponseSchema.parse(await listResponse.json());
    expect(list.data[0]?.id).toBe('run_contract');
    expect(list.page.limit).toBe(1);

    const detailResponse = await getAdminRun(
      new Request('http://localhost/api/admin/runs/run_contract'),
      { id: 'run_contract' },
    );
    expect(detailResponse.status).toBe(200);
    const detail = AdminRunDetailResponseSchema.parse(await detailResponse.json());
    expect(detail.timeline.map((event) => event.type)).toContain('cost_ledger');
  });

  it('matches cost, failure-cluster and today response schemas', async () => {
    await seedObservabilityRows('failure');

    const costResponse = await getAdminCost(new Request('http://localhost/api/admin/cost?days=7'));
    expect(costResponse.status).toBe(200);
    expect(AdminCostResponseSchema.parse(await costResponse.json()).days_window).toBe(7);

    const failuresResponse = await getAdminFailures(
      new Request('http://localhost/api/admin/failures?limit=bogus'),
    );
    expect(failuresResponse.status).toBe(200);
    const failures = AdminFailuresResponseSchema.parse(await failuresResponse.json());
    expect(failures.limit).toBe(50);
    expect(failures.clusters).toHaveLength(1);

    const todayResponse = await getTodayCost(new Request('http://localhost/api/cost/today'));
    expect(todayResponse.status).toBe(200);
    const today = CostTodayResponseSchema.parse(await todayResponse.json());
    expect(today.today.by_currency).toEqual([
      {
        currency: 'USD',
        cost: 0.25,
        reported_cost: 0,
        estimated_cost: 0,
        legacy_cost: 0.25,
        unknown_attempts: 0,
        legacy_rows: 1,
      },
    ]);
    expect(today.today).toMatchObject({ unknown_attempts: 0, legacy_rows: 1 });
    expect(today.today.by_truth).toEqual([
      {
        currency: 'USD',
        entry_kind: 'legacy',
        cost_basis: null,
        cost_ref: null,
        cost: 0.25,
        tokens_in: 12,
        tokens_out: 3,
        calls: 1,
        unknown_attempts: 0,
      },
    ]);
    expect(today.today.tool_calls).toBe(1);
  });

  it('keeps unknown today attempts out of spend while preserving auditable truth refs', async () => {
    const occurredAt = new Date();
    await db.insert(cost_ledger).values([
      {
        id: 'today_reported',
        task_run_id: 'today_run_reported',
        task_kind: 'TodayTask',
        provider: 'anthropic',
        model: 'claude',
        cost: 0.1,
        entry_kind: 'attempt',
        cost_basis: 'reported',
        cost_ref: 'sdk:total_cost_usd',
        tokens_in: 10,
        tokens_out: 1,
        occurred_at: occurredAt,
      },
      {
        id: 'today_estimated',
        task_run_id: 'today_run_estimated',
        task_kind: 'TodayTask',
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        cost: 0.2,
        entry_kind: 'attempt',
        cost_basis: 'estimated',
        cost_ref: 'pricebook:test',
        tokens_in: 20,
        tokens_out: 2,
        occurred_at: occurredAt,
      },
      {
        id: 'today_unknown',
        task_run_id: 'today_run_unknown',
        task_kind: 'TodayTask',
        provider: 'xiaomi',
        model: 'mimo-future',
        cost: null,
        entry_kind: 'attempt',
        cost_basis: 'unknown',
        cost_ref: 'unpriced:xiaomi/mimo-future',
        tokens_in: 0,
        tokens_out: 0,
        occurred_at: occurredAt,
      },
    ]);

    const response = await getTodayCost(new Request('http://localhost/api/cost/today'));
    const today = CostTodayResponseSchema.parse(await response.json()).today;
    expect(today.by_currency[0]?.cost).toBeCloseTo(0.3, 5);
    expect(today).toMatchObject({ unknown_attempts: 1, legacy_rows: 0, ledger_rows: 3 });
    expect(today.by_truth).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cost_basis: 'reported',
          cost_ref: 'sdk:total_cost_usd',
          cost: expect.closeTo(0.1, 5),
        }),
        expect.objectContaining({
          cost_basis: 'estimated',
          cost_ref: 'pricebook:test',
          cost: expect.closeTo(0.2, 5),
        }),
        expect.objectContaining({
          cost_basis: 'unknown',
          cost_ref: 'unpriced:xiaomi/mimo-future',
          cost: 0,
          unknown_attempts: 1,
        }),
      ]),
    );
  });
});

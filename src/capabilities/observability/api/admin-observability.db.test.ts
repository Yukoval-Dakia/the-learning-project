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
    expect(today.today.by_currency).toEqual([{ currency: 'USD', cost: 0.25 }]);
    expect(today.today.tool_calls).toBe(1);
  });
});

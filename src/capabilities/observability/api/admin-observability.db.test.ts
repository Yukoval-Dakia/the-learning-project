import { beforeEach, describe, expect, it } from 'vitest';
import { ai_task_runs, cost_ledger, provider_attempt, tool_call_log } from '@/db/schema';
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

  it('projects provider attempt cost truth once and excludes no-wire attempts', async () => {
    const occurredAt = new Date();
    const base = {
      operation_id: '00000000-0000-4000-8000-000000000930',
      attempt_kind: 'wire',
      provider: 'glm',
      model: 'glm-5.2',
      lane_id: 'glm.memory-reconcile',
      protocol: 'http',
      endpoint_class: 'openai-compatible.chat-completions',
      caller: 'worker',
      operation_kind: 'memory_reconcile',
      terminal_status: 'succeeded',
      terminal_reason: 'provider_response_accepted',
      wire_count: 1,
      usage_json: {
        basis: 'reported',
        unit: 'tokens',
        input: 100,
        output: 20,
        total: 120,
        source: 'provider_response',
      },
      started_at: occurredAt,
      provider_start_reserved_at: occurredAt,
      finished_at: occurredAt,
    } as const;
    await db.insert(provider_attempt).values([
      {
        ...base,
        attempt_id: '00000000-0000-4000-8000-000000000931',
        cost_basis: 'reported',
        cost_amount: 0.1,
        cost_currency: 'CNY',
        cost_source: 'provider_response',
      },
      {
        ...base,
        attempt_id: '00000000-0000-4000-8000-000000000932',
        cost_basis: 'estimated',
        cost_amount: 0.2,
        cost_currency: 'CNY',
        cost_source: 'glm-chat-pricebook',
      },
      {
        ...base,
        attempt_id: '00000000-0000-4000-8000-000000000933',
        cost_basis: 'unknown',
        cost_amount: null,
        cost_currency: null,
        cost_source: 'provider_cost_absent',
      },
      {
        ...base,
        attempt_id: '00000000-0000-4000-8000-000000000934',
        terminal_status: null,
        terminal_reason: null,
        wire_count: null,
        usage_json: null,
        cost_basis: null,
        cost_amount: null,
        cost_currency: null,
        cost_source: null,
        provider_start_reserved_at: null,
        finished_at: null,
      },
    ]);
    await db.insert(cost_ledger).values({
      id: 'legacy_duplicate',
      task_run_id: '00000000-0000-4000-8000-000000000931',
      task_kind: 'memory_reconcile',
      provider: 'glm',
      model: 'glm-5.2',
      cost: 0.1,
      currency: 'CNY',
      tokens_in: 100,
      tokens_out: 20,
      occurred_at: occurredAt,
    });

    const response = await getTodayCost(new Request('http://localhost/api/cost/today'));
    const today = CostTodayResponseSchema.parse(await response.json()).today;

    expect(today.ledger_rows).toBe(3);
    expect(today.unknown_attempts).toBe(1);
    expect(today.by_currency.find((row) => row.currency === 'CNY')?.cost).toBeCloseTo(0.3, 5);
    expect(today.by_currency.find((row) => row.currency === 'XXX')?.cost).toBe(0);
  });

  it('retains unlinked OCR legacy rows before and after an authoritative attempt', async () => {
    const now = new Date();
    const bjt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const attemptTime = new Date(
      Date.UTC(bjt.getUTCFullYear(), bjt.getUTCMonth(), bjt.getUTCDate()) - 7 * 60 * 60 * 1000,
    );
    const historicalTime = new Date(attemptTime.getTime() - 60_000);
    await db.insert(cost_ledger).values([
      {
        id: 'legacy_ocr_before_cutover',
        task_run_id: null,
        task_kind: 'tencent_ocr_extract',
        provider: 'tencent',
        model: 'question-mark-agent',
        cost: 0.4,
        currency: 'CNY',
        tokens_in: 0,
        tokens_out: 0,
        occurred_at: historicalTime,
      },
      {
        id: 'legacy_ocr_after_cutover',
        task_run_id: 'unrelated-legacy-ocr-job',
        task_kind: 'tencent_ocr_extract',
        provider: 'tencent',
        model: 'question-mark-agent',
        cost: 0.6,
        currency: 'CNY',
        tokens_in: 0,
        tokens_out: 0,
        occurred_at: new Date(attemptTime.getTime() + 1_000),
      },
    ]);
    await db.insert(provider_attempt).values({
      attempt_id: '00000000-0000-4000-8000-000000000935',
      operation_id: '00000000-0000-4000-8000-000000000936',
      attempt_kind: 'wire',
      provider: 'tencent',
      model: null,
      lane_id: 'tencent.question-mark-agent',
      protocol: 'tencent-sdk',
      endpoint_class: 'question-mark-agent.submit',
      caller: 'worker',
      operation_kind: 'ocr_page_submit',
      terminal_status: 'succeeded',
      terminal_reason: 'provider_response_accepted',
      wire_count: 1,
      usage_json: {
        basis: 'unknown',
        unit: null,
        input: null,
        output: null,
        total: null,
        source: 'tencent_sdk_usage_unavailable',
      },
      cost_basis: 'unknown',
      cost_amount: null,
      cost_currency: null,
      cost_source: 'tencent_sdk_cost_unavailable',
      started_at: attemptTime,
      provider_start_reserved_at: attemptTime,
      finished_at: attemptTime,
    });

    const response = await getTodayCost(new Request('http://localhost/api/cost/today'));
    const today = CostTodayResponseSchema.parse(await response.json()).today;

    expect(today.ledger_rows).toBe(3);
    expect(today.unknown_attempts).toBe(1);
    expect(today.legacy_rows).toBe(2);
    expect(today.by_currency.find((row) => row.currency === 'CNY')?.cost).toBeCloseTo(1, 5);

    const adminResponse = await getAdminCost(new Request('http://localhost/api/admin/cost?days=7'));
    const admin = AdminCostResponseSchema.parse(await adminResponse.json());
    expect(admin.by_task).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_kind: 'tencent_ocr_extract',
          currency: 'CNY',
          cost: expect.closeTo(1, 5),
          calls: 2,
          legacy_rows: 2,
        }),
        expect.objectContaining({
          task_kind: 'ocr_page_submit',
          currency: 'XXX',
          cost: 0,
          calls: 1,
          unknown_attempts: 1,
        }),
      ]),
    );
  });
});

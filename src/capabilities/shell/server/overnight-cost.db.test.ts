import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { readProviderCostWindow } from '@/capabilities/observability/public';
import { ai_task_runs, cost_ledger, provider_attempt } from '@/db/schema';
import { loadTodayOvernightDigest as loadOvernightDigest } from '@/server/today/overnight-digest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { OvernightDigestResponseSchema } from '../api/contracts';

const db = testDb();
const NOW = new Date('2026-10-04T06:00:00Z');
const FROM = new Date('2026-10-02T16:00:00Z');
const TO = new Date('2026-10-03T16:00:00Z');
const MID = new Date('2026-10-03T03:00:00Z');

async function attempt(overrides: Partial<typeof provider_attempt.$inferInsert> = {}) {
  const attempt_id = randomUUID();
  await db.insert(provider_attempt).values({
    attempt_id,
    operation_id: randomUUID(),
    attempt_kind: 'wire',
    provider: 'opencode-go',
    model: 'glm-5',
    lane_id: 'opencode-go.chat',
    protocol: 'openai-completions',
    endpoint_class: 'chat',
    caller: 'worker',
    operation_kind: 'NightlyReviewTask',
    terminal_status: 'succeeded',
    terminal_reason: 'provider_response_accepted',
    wire_count: 1,
    usage_json: {
      basis: 'reported',
      unit: 'tokens',
      input: 1234,
      output: 67,
      total: 1301,
      source: 'provider-response',
    },
    cost_basis: 'estimated',
    cost_amount: 0.000008,
    cost_currency: 'USD',
    cost_source: 'catalog-estimated',
    started_at: FROM,
    provider_start_reserved_at: FROM,
    finished_at: MID,
    ...overrides,
  });
  return attempt_id;
}
async function ledger(overrides: Partial<typeof cost_ledger.$inferInsert> = {}) {
  await db.insert(cost_ledger).values({
    id: randomUUID(),
    task_run_id: null,
    task_kind: 'LegacyTask',
    provider: 'legacy-provider',
    model: 'legacy-model',
    cost: 0.25,
    currency: 'CNY',
    tokens_in: 55,
    tokens_out: 6,
    outcome: 'success',
    occurred_at: MID,
    ...overrides,
  });
}
async function cost() {
  const digest = await loadOvernightDigest(db, NOW);
  expect(digest.cost).toBeDefined();
  expect(OvernightDigestResponseSchema.parse(digest).cost).toEqual(digest.cost);
  return digest.cost;
}

describe('overnight cost observation', () => {
  beforeEach(resetDb);

  it('has an explicit empty ledger, distinct from a reported zero or quiet business activity', async () => {
    expect(await cost()).toEqual({
      scope: 'all_activity',
      records: 0,
      by_currency: [],
      details: [],
    });
    const empty = await loadOvernightDigest(db, NOW);
    expect(empty.has_overnight_activity).toBe(false);
    await attempt({ cost_basis: 'reported', cost_amount: 0, cost_source: 'provider-response' });
    const d = await loadOvernightDigest(db, NOW);
    expect(d.has_overnight_activity).toBe(false);
    expect(d.runs).toEqual([]);
    expect(d.cost.by_currency).toEqual([
      expect.objectContaining({ currency: 'USD', cost: 0, reported_attempts: 1 }),
    ]);
  });

  it('bounds both sources to the exact previous BJT calendar day [from,to)', async () => {
    for (const at of [new Date(FROM.getTime() - 1), FROM, new Date(TO.getTime() - 1), TO]) {
      await attempt({
        finished_at: at,
        started_at: new Date(FROM.getTime() - 1000),
        provider_start_reserved_at: new Date(FROM.getTime() - 1000),
      });
      await ledger({ occurred_at: at });
    }
    const c = await cost();
    expect(c.records).toBe(4);
    expect(c.by_currency.find((r) => r.currency === 'USD')?.estimated_attempts).toBe(2);
    expect(c.by_currency.find((r) => r.currency === 'CNY')?.legacy_rows).toBe(2);
  });

  it('deduplicates only UUID-linked authoritative attempts, including echoes across window edges', async () => {
    const inside = await attempt();
    const outside = await attempt({ finished_at: TO });
    await ledger({ task_run_id: inside, cost: 123 });
    await ledger({ task_run_id: outside, cost: 456 });
    await ledger({ task_run_id: inside, occurred_at: TO, cost: 789 });
    await ledger({ task_run_id: 'not-a-uuid', cost: 0.25 });
    await ledger({ task_run_id: null, cost: 0.5 });
    expect((await cost()).records).toBe(3);
    expect((await cost()).by_currency.find((r) => r.currency === 'CNY')?.cost).toBeCloseTo(0.75);
  });

  it('includes failed/retried costs and separates currencies, basis, provider/model/lane and task', async () => {
    const retried = await attempt({
      terminal_status: 'failed',
      terminal_reason: 'transport_error',
      cost_basis: 'reported',
      cost_amount: 0.1,
    });
    await db.insert(ai_task_runs).values({
      id: retried,
      task_kind: 'NightlyReviewTask',
      provider: 'opencode-go',
      model: 'glm-5',
      input_hash: '失败后有重试；不能因告警过滤而删除真实费用',
      status: 'failure',
      finish_reason: 'error_retried',
      started_at: FROM,
      finished_at: MID,
    });
    await attempt({
      lane_id: 'opencode-go.interactive',
      caller: 'api',
      operation_kind: 'CopilotTask',
    });
    await attempt({
      provider: 'tencent',
      model: null,
      lane_id: 'tencent.ocr',
      operation_kind: 'OCR',
      cost_basis: 'reported',
      cost_amount: 0.2,
      cost_currency: 'CNY',
    });
    await ledger();
    const c = await cost();
    expect(c.records).toBe(4);
    expect(c.by_currency).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currency: 'USD',
          reported_cost: 0.1,
          estimated_cost: 0.000008,
          reported_attempts: 1,
          estimated_attempts: 1,
        }),
        expect.objectContaining({
          currency: 'CNY',
          reported_cost: 0.2,
          legacy_cost: 0.25,
          legacy_rows: 1,
        }),
      ]),
    );
    expect(c.details.map((r) => r.lane_id).sort()).toEqual(
      [null, 'opencode-go.chat', 'opencode-go.interactive', 'tencent.ocr'].sort(),
    );
    expect(c.details.find((r) => r.task_kind === 'LegacyTask')).toMatchObject({
      provider: 'legacy-provider',
      model: 'legacy-model',
      lane_id: null,
      usage_basis: 'unclassified',
      unknown_wire_records: 1,
      wire_calls: null,
    });
  });

  it('retains unknown amounts and partial/non-token usage without turning missing values into zero', async () => {
    await attempt({
      cost_basis: 'unknown',
      cost_amount: null,
      cost_currency: null,
      cost_source: 'missing',
      wire_count: 2,
      usage_json: {
        basis: 'unknown',
        unit: null,
        input: null,
        output: null,
        total: null,
        source: 'absent',
      },
    });
    await attempt({
      provider: 'ocr',
      model: null,
      lane_id: 'ocr.pages',
      usage_json: {
        basis: 'reported',
        unit: 'pages',
        input: 3,
        output: null,
        total: 3,
        source: 'page-counter',
      },
    });
    const c = await cost();
    expect(c.by_currency.find((r) => r.currency === 'XXX')).toMatchObject({
      cost: 0,
      unknown_attempts: 1,
      reported_attempts: 0,
      estimated_attempts: 0,
    });
    expect(c.details.find((r) => r.cost_basis === 'unknown')).toMatchObject({
      amount: null,
      usage_basis: 'unknown',
      usage_unit: null,
      usage_input: null,
      usage_output: null,
      usage_total: null,
      missing_input_records: 1,
      missing_output_records: 1,
      wire_calls: 2,
    });
    expect(c.details.find((r) => r.provider === 'ocr')).toMatchObject({
      usage_unit: 'pages',
      usage_input: 3,
      usage_output: null,
      missing_output_records: 1,
    });
  });

  it('excludes unfinished/unstarted/no-wire calls but retains opaque operations and their unknown physical call count', async () => {
    await attempt({
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
    });
    const noWire = await attempt({ wire_count: 0 });
    await ledger({ task_run_id: noWire, cost: 0.125 });
    await attempt({
      attempt_kind: 'opaque_operation',
      wire_count: null,
      operation_kind: 'opaque-worker',
    });
    const c = await cost();
    expect(c.records).toBe(2);
    expect(c.details.find((r) => r.task_kind === 'opaque-worker')).toMatchObject({
      records: 1,
      wire_calls: null,
      unknown_wire_records: 1,
    });
    expect(c.by_currency.find((r) => r.currency === 'CNY')?.cost).toBeCloseTo(0.125);
  });
  it('aggregates repeated records while keeping missing usage and opaque call counts explicit', async () => {
    await attempt({
      usage_json: {
        basis: 'reported',
        unit: 'tokens',
        input: 20,
        output: 0,
        total: null,
        source: 'partial-response',
      },
    });
    await attempt({
      attempt_kind: 'opaque_operation',
      wire_count: null,
      usage_json: {
        basis: 'reported',
        unit: 'tokens',
        input: 30,
        output: null,
        total: null,
        source: 'partial-response',
      },
    });
    const c = await cost();
    expect(c.details).toHaveLength(1);
    expect(c.details[0]).toMatchObject({
      records: 2,
      usage_input: 50,
      usage_output: 0,
      usage_total: null,
      missing_input_records: 0,
      missing_output_records: 1,
      missing_total_records: 2,
      wire_calls: 1,
      unknown_wire_records: 1,
    });
    expect(c.by_currency[0]).toMatchObject({ estimated_attempts: 2 });
    expect(c.by_currency[0].estimated_cost).toBeCloseTo(0.000016, 9);
  });

  it('retains unlinked attempt-ledger unknown truth without inventing lane or usage provenance', async () => {
    await ledger({
      task_run_id: randomUUID(),
      entry_kind: 'attempt',
      cost_basis: 'unknown',
      cost_ref: 'runner-no-cost',
      cost: null,
      tokens_in: 0,
      tokens_out: 0,
    });
    const c = await cost();
    expect(c.by_currency).toEqual([
      expect.objectContaining({ currency: 'CNY', cost: 0, unknown_attempts: 1, legacy_rows: 0 }),
    ]);
    expect(c.details[0]).toMatchObject({
      source: 'cost_ledger',
      lane_id: null,
      amount: null,
      cost_basis: 'unknown',
      usage_basis: 'unclassified',
      usage_total: null,
    });
  });

  it('rejects invalid or reversed windows instead of producing an unbounded report', async () => {
    await expect(readProviderCostWindow(db, TO, FROM)).rejects.toThrow(RangeError);
    await expect(readProviderCostWindow(db, FROM, FROM)).rejects.toThrow(RangeError);
    await expect(readProviderCostWindow(db, new Date('invalid'), TO)).rejects.toThrow(RangeError);
  });
});

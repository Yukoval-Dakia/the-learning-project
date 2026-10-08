import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TodayCost, loadTodayCost } from '@/capabilities/observability/public';
import { type Db, type Tx, db as singletonDb } from '@/db/client';
import { cost_ledger, provider_attempt, tool_call_log } from '@/db/schema';
import {
  beginTestTransaction,
  resetDb,
  rollbackTestTransaction,
  testDb,
} from '../../../../tests/helpers/db';
import { CostTodayResponseSchema } from '../api/admin-observability-contracts';
import { GET } from '../api/cost-today';

const now = new Date('2026-10-08T19:30:00.123Z');

function ledger(
  id: string,
  cost: number | null,
  basis: 'reported' | 'estimated' | 'unknown' | null,
  tokens: number,
  occurredAt = now,
  currency = 'USD',
  taskKind = 'AnalysisTask',
): typeof cost_ledger.$inferInsert {
  return {
    id,
    task_run_id: `run_${id}`,
    task_kind: taskKind,
    provider: 'test',
    model: 'cost-fixture',
    cost,
    currency,
    entry_kind: basis === null ? 'legacy' : 'attempt',
    cost_basis: basis,
    cost_ref: basis === null ? null : `fixture:${id}`,
    tokens_in: tokens,
    tokens_out: tokens / 10,
    occurred_at: occurredAt,
  };
}

function attempt(
  suffix: string,
  basis: 'reported' | 'estimated' | 'unknown',
  amount: number | null,
): typeof provider_attempt.$inferInsert {
  return {
    attempt_id: `00000000-0000-4000-8000-000000001${suffix}`,
    operation_id: '00000000-0000-4000-8000-000000001378',
    attempt_kind: 'wire',
    provider: 'glm',
    model: 'glm-fixture',
    lane_id: 'glm.memory-reconcile',
    protocol: 'http',
    endpoint_class: 'openai-compatible.chat-completions',
    caller: 'worker',
    operation_kind: 'AnalysisTask',
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
    cost_basis: basis,
    cost_amount: amount,
    cost_currency: 'CNY',
    cost_source: `fixture:provider_${basis}`,
    started_at: now,
    provider_start_reserved_at: now,
    finished_at: now,
  };
}

async function tool(db: Db | Tx, id: string, occurredAt: Date): Promise<void> {
  await db.insert(tool_call_log).values({
    id,
    task_run_id: 'tool_run',
    task_kind: 'AnalysisTask',
    tool_name: 'read_evidence',
    input_json: { nested: { query: '保留条件、歧义和失败证据。'.repeat(100), limit: 7 } },
    output_json: { records: [{ id: 'evidence_1', warnings: ['ambiguous condition'] }] },
    iteration: 2,
    latency_ms: 12,
    cost: 0,
    occurred_at: occurredAt,
  });
}

function sortedCurrencies(rows: TodayCost['today']['by_currency']) {
  return [...rows].sort((a, b) => a.currency.localeCompare(b.currency));
}

describe('Today cost injected database read', () => {
  beforeEach(async () => {
    await resetDb();
    await beginTestTransaction();
  });
  afterEach(rollbackTestTransaction);

  it('reads uncommitted mixed cost truth through a real Tx while the singleton stays empty', async () => {
    await testDb().transaction(async (tx) => {
      await tx.insert(cost_ledger).values([
        ledger('reported', 0.5, 'reported', 10),
        ledger('estimated', 0.25, 'estimated', 20),
        ledger('unknown', null, 'unknown', 30),
        ledger('known_zero', 0, 'reported', 40),
        ledger('legacy_usd', 0.125, null, 50),
        ledger('legacy_cny', 0.25, null, 70, now, 'CNY', 'LegacyTask'),
        // Linked ledger cost must not duplicate its authoritative provider attempt.
        {
          ...ledger('linked_duplicate', 999, null, 990, now, 'CNY'),
          task_run_id: '00000000-0000-4000-8000-000000001381',
        },
      ]);
      await tx
        .insert(provider_attempt)
        .values([
          attempt('381', 'reported', 0.75),
          attempt('382', 'estimated', 1.5),
          attempt('383', 'unknown', null),
        ]);
      await tool(tx, 'today_tool', now);
      await tool(tx, 'future_tool', new Date(now.getTime() + 86_400_000));
      await tool(tx, 'previous_tool', new Date('2026-10-08T15:59:59.999Z'));

      const singleton = await loadTodayCost(singletonDb, now);
      expect(singleton.today.ledger_rows).toBe(0);
      expect(singleton.today.tool_calls).toBe(0);
      const http = await GET(new Request('http://localhost/api/cost/today'));
      expect(http.status).toBe(200);
      expect(CostTodayResponseSchema.parse(await http.json()).today.ledger_rows).toBe(0);

      const result = await loadTodayCost(tx, now);
      expect(CostTodayResponseSchema.parse(result)).toEqual(result);
      expect(result.window).toEqual({
        from: Date.parse('2026-10-08T16:00:00Z') / 1000,
        to: Math.floor(now.getTime() / 1000),
        label: 'BJT today (from local midnight)',
      });
      expect(result.today).toMatchObject({
        tokens_in: 520,
        tokens_out: 82,
        ledger_rows: 9,
        unknown_attempts: 2,
        legacy_rows: 2,
        tool_calls: 2,
      });
      const usd = {
        currency: 'USD',
        cost: 0.875,
        reported_cost: 0.5,
        estimated_cost: 0.25,
        legacy_cost: 0.125,
        reported_attempts: 2,
        estimated_attempts: 1,
        unknown_attempts: 1,
        legacy_rows: 1,
      };
      const cny = {
        currency: 'CNY',
        cost: 2.5,
        reported_cost: 0.75,
        estimated_cost: 1.5,
        legacy_cost: 0.25,
        reported_attempts: 1,
        estimated_attempts: 1,
        unknown_attempts: 1,
        legacy_rows: 1,
      };
      expect(sortedCurrencies(result.today.by_currency)).toEqual([cny, usd]);
      expect(result.today).not.toHaveProperty('cost');
      expect(result.today.by_task).toHaveLength(2);
      const analysis = result.today.by_task.find((row) => row.task_kind === 'AnalysisTask');
      expect(analysis?.calls).toBe(8);
      expect(sortedCurrencies(analysis?.by_currency ?? [])).toEqual([
        { ...cny, cost: 2.25, legacy_cost: 0, legacy_rows: 0 },
        usd,
      ]);
      expect(result.today.by_task.find((row) => row.task_kind === 'LegacyTask')).toEqual({
        task_kind: 'LegacyTask',
        calls: 1,
        by_currency: [
          {
            ...cny,
            cost: 0.25,
            reported_cost: 0,
            estimated_cost: 0,
            reported_attempts: 0,
            estimated_attempts: 0,
            unknown_attempts: 0,
          },
        ],
      });
      const expectedTruth = [
        {
          currency: 'USD',
          entry_kind: 'attempt',
          cost_basis: 'reported',
          cost_ref: 'fixture:reported',
          cost: 0.5,
          tokens_in: 10,
          tokens_out: 1,
          calls: 1,
          unknown_attempts: 0,
        },
        {
          currency: 'USD',
          entry_kind: 'attempt',
          cost_basis: 'estimated',
          cost_ref: 'fixture:estimated',
          cost: 0.25,
          tokens_in: 20,
          tokens_out: 2,
          calls: 1,
          unknown_attempts: 0,
        },
        {
          currency: 'USD',
          entry_kind: 'attempt',
          cost_basis: 'unknown',
          cost_ref: 'fixture:unknown',
          cost: 0,
          tokens_in: 30,
          tokens_out: 3,
          calls: 1,
          unknown_attempts: 1,
        },
        {
          currency: 'USD',
          entry_kind: 'attempt',
          cost_basis: 'reported',
          cost_ref: 'fixture:known_zero',
          cost: 0,
          tokens_in: 40,
          tokens_out: 4,
          calls: 1,
          unknown_attempts: 0,
        },
        {
          currency: 'USD',
          entry_kind: 'legacy',
          cost_basis: null,
          cost_ref: null,
          cost: 0.125,
          tokens_in: 50,
          tokens_out: 5,
          calls: 1,
          unknown_attempts: 0,
        },
        {
          currency: 'CNY',
          entry_kind: 'legacy',
          cost_basis: null,
          cost_ref: null,
          cost: 0.25,
          tokens_in: 70,
          tokens_out: 7,
          calls: 1,
          unknown_attempts: 0,
        },
        {
          currency: 'CNY',
          entry_kind: 'attempt',
          cost_basis: 'reported',
          cost_ref: 'fixture:provider_reported',
          cost: 0.75,
          tokens_in: 100,
          tokens_out: 20,
          calls: 1,
          unknown_attempts: 0,
        },
        {
          currency: 'CNY',
          entry_kind: 'attempt',
          cost_basis: 'estimated',
          cost_ref: 'fixture:provider_estimated',
          cost: 1.5,
          tokens_in: 100,
          tokens_out: 20,
          calls: 1,
          unknown_attempts: 0,
        },
        {
          currency: 'CNY',
          entry_kind: 'attempt',
          cost_basis: 'unknown',
          cost_ref: 'fixture:provider_unknown',
          cost: 0,
          tokens_in: 100,
          tokens_out: 20,
          calls: 1,
          unknown_attempts: 1,
        },
      ] satisfies TodayCost['today']['by_truth'];
      expect(result.today.by_truth).toHaveLength(expectedTruth.length);
      expect(result.today.by_truth).toEqual(expect.arrayContaining(expectedTruth));
    });
    await rollbackTestTransaction();
    expect((await loadTodayCost(testDb(), now)).today.ledger_rows).toBe(0);
  });

  it.each([
    ['2026-10-08T15:59:59.999Z', '2026-10-07T16:00:00Z', 15, 4],
    ['2026-10-08T16:00:00.000Z', '2026-10-08T16:00:00Z', 14, 3],
    ['2026-10-08T16:00:00.001Z', '2026-10-08T16:00:00Z', 14, 3],
  ])(
    'preserves inclusive midnight and lower-bound-only reads at %s',
    async (nowIso, fromIso, cost, calls) => {
      const db = testDb();
      const times = [
        '2026-10-08T15:59:59.999Z',
        '2026-10-08T16:00:00Z',
        '2026-10-08T16:00:00.001Z',
        '2026-10-09T16:00:00Z',
      ];
      await db
        .insert(cost_ledger)
        .values(
          times.map((at, index) => ledger(`boundary_${index}`, 2 ** index, null, 10, new Date(at))),
        );
      for (const [index, at] of times.entries())
        await tool(db, `boundary_tool_${index}`, new Date(at));
      const result = await loadTodayCost(db, new Date(nowIso));
      expect(result.window).toEqual({
        from: Date.parse(fromIso) / 1000,
        to: Math.floor(Date.parse(nowIso) / 1000),
        label: 'BJT today (from local midnight)',
      });
      expect(result.today.by_currency[0]?.cost).toBe(cost);
      expect(result.today).toMatchObject({
        ledger_rows: calls,
        tool_calls: calls,
        legacy_rows: calls,
        tokens_in: calls * 10,
        tokens_out: calls,
      });
    },
  );

  it('returns the complete empty DTO through an injected Db', async () => {
    const result = await loadTodayCost(testDb(), now);
    expect(CostTodayResponseSchema.parse(result)).toEqual(result);
    expect(result.today).toEqual({
      by_currency: [],
      tokens_in: 0,
      tokens_out: 0,
      ledger_rows: 0,
      unknown_attempts: 0,
      legacy_rows: 0,
      tool_calls: 0,
      by_truth: [],
      by_task: [],
    });
  });
});

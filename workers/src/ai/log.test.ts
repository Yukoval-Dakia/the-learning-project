import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { writeCostLedger, writeToolCallLog } from './log';

function makeMockDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return { run: async () => ({ success: true }) };
    },
  }));
  return { db: { prepare } as unknown as D1Database, calls };
}

describe('writeToolCallLog', () => {
  it('inserts a row with all required fields', async () => {
    const { db, calls } = makeMockDb();
    await writeToolCallLog(db, {
      task_run_id: 'tr_1',
      task_kind: 'AttributionTask',
      tool_name: 'search_knowledge_by_concept',
      input_json: { concept: '宾语前置' },
      output_json: { results: [] },
      iteration: 1,
      latency_ms: 234,
      cost: 0.001,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/insert into.*tool_call_log/i);
    // id, task_run_id, task_kind, tool_name, input_json, output_json, iteration, latency_ms, cost, occurred_at
    expect(calls[0].binds).toHaveLength(10);
    expect(calls[0].binds[1]).toBe('tr_1');
    expect(calls[0].binds[2]).toBe('AttributionTask');
    expect(calls[0].binds[3]).toBe('search_knowledge_by_concept');
  });
});

describe('writeCostLedger', () => {
  it('inserts a row with all required fields', async () => {
    const { db, calls } = makeMockDb();
    await writeCostLedger(db, {
      task_kind: 'AttributionTask',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      cost: 0.012,
      tokens_in: 1234,
      tokens_out: 567,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/insert into.*cost_ledger/i);
    expect(calls[0].binds).toHaveLength(8);
    expect(calls[0].binds[1]).toBe('AttributionTask');
    expect(calls[0].binds[2]).toBe('anthropic');
    expect(calls[0].binds[3]).toBe('claude-sonnet-4-6');
  });
});

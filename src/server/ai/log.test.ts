import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { writeCostLedger, writeToolCallLog } from './log';

describe('writeToolCallLog', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a row with all required fields', async () => {
    const db = testDb();
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

    const { tool_call_log } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(tool_call_log).where(eq(tool_call_log.task_run_id, 'tr_1'));
    expect(rows).toHaveLength(1);
    expect(rows[0].task_kind).toBe('AttributionTask');
    expect(rows[0].tool_name).toBe('search_knowledge_by_concept');
    expect(rows[0].iteration).toBe(1);
  });
});

describe('writeCostLedger', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a row with all required fields', async () => {
    const db = testDb();
    await writeCostLedger(db, {
      task_kind: 'AttributionTask',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      cost: 0.012,
      tokens_in: 1234,
      tokens_out: 567,
    });

    const { cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('anthropic');
    expect(rows[0].model).toBe('claude-sonnet-4-6');
    expect(rows[0].tokens_in).toBe(1234);
    expect(rows[0].tokens_out).toBe(567);
  });
});

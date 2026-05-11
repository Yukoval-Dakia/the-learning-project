import { cost_ledger } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { GET } from './route';

const db = testDb();

function makeLedgerRow(overrides: Partial<typeof cost_ledger.$inferInsert> & { id: string }) {
  return {
    task_kind: 'AttributionTask',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    cost: 0.01,
    tokens_in: 1000,
    tokens_out: 200,
    occurred_at: new Date('2026-05-08T12:00:00Z'),
    ...overrides,
  };
}

describe('GET /api/_/logs/cost', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns aggregated cost rows with default range=day', async () => {
    await db
      .insert(cost_ledger)
      .values([
        makeLedgerRow({ id: 'cl_1', cost: 0.005, tokens_in: 500, tokens_out: 100 }),
        makeLedgerRow({ id: 'cl_2', cost: 0.003, tokens_in: 300, tokens_out: 60 }),
      ]);

    const req = new Request('http://localhost/api/_/logs/cost');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { bucket: string; cost_sum: number; call_count: number }[];
      range: string;
    };
    expect(body.range).toBe('day');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].bucket).toBe('2026-05-08');
    expect(body.items[0].call_count).toBe(2);
    expect(body.items[0].cost_sum).toBeCloseTo(0.008, 5);
  });

  it('accepts range=week', async () => {
    const req = new Request('http://localhost/api/_/logs/cost?range=week');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { range: string };
    expect(body.range).toBe('week');
  });

  it('accepts range=month', async () => {
    const req = new Request('http://localhost/api/_/logs/cost?range=month');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { range: string };
    expect(body.range).toBe('month');
  });

  it('rejects invalid range with 400', async () => {
    const req = new Request('http://localhost/api/_/logs/cost?range=bogus');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_range');
  });

  it('groups by bucket, task_kind, model and orders by bucket desc', async () => {
    await db
      .insert(cost_ledger)
      .values([
        makeLedgerRow({ id: 'cl_may8', cost: 0.01, occurred_at: new Date('2026-05-08T00:00:00Z') }),
        makeLedgerRow({ id: 'cl_may9', cost: 0.02, occurred_at: new Date('2026-05-09T00:00:00Z') }),
      ]);

    const req = new Request('http://localhost/api/_/logs/cost?range=day');
    const res = await GET(req);
    const body = (await res.json()) as { items: { bucket: string }[] };
    expect(body.items[0].bucket).toBe('2026-05-09');
    expect(body.items[1].bucket).toBe('2026-05-08');
  });
});

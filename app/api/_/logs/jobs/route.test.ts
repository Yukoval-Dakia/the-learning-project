import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { cost_ledger } from '@/db/schema';
import { GET as getById } from './[id]/route';
import { GET as getList } from './route';

beforeEach(async () => {
  // clear cost_ledger between tests to avoid interference
  await db.delete(cost_ledger);
});

async function insertCost(opts: {
  pgboss_job_id: string | null;
  outcome: 'success' | 'failed_retryable' | 'failed_permanent';
  task_kind: string;
  cost?: number;
  tokens_in?: number;
  tokens_out?: number;
  occurred_at?: Date;
}) {
  await db.insert(cost_ledger).values({
    id: createId(),
    task_kind: opts.task_kind,
    provider: 'tencent',
    model: 'fake',
    cost: opts.cost ?? 0,
    tokens_in: opts.tokens_in ?? 0,
    tokens_out: opts.tokens_out ?? 0,
    outcome: opts.outcome,
    pgboss_job_id: opts.pgboss_job_id,
    occurred_at: opts.occurred_at ?? new Date(),
  });
}

describe('GET /api/_/logs/jobs', () => {
  it('groups by pgboss_job_id, returns aggregated attempts/cost/tokens', async () => {
    // Job A: 2 attempts (retryable then success)
    await insertCost({
      pgboss_job_id: 'job-A',
      outcome: 'failed_retryable',
      task_kind: 'tencent_ocr_extract',
      cost: 0.01,
      occurred_at: new Date(Date.now() - 60_000),
    });
    await insertCost({
      pgboss_job_id: 'job-A',
      outcome: 'success',
      task_kind: 'tencent_ocr_extract',
      cost: 0.02,
      tokens_in: 100,
    });
    // Job B: 1 attempt
    await insertCost({ pgboss_job_id: 'job-B', outcome: 'success', task_kind: 'echo', cost: 0 });
    // Row without pgboss_job_id (manual run) should be excluded
    await insertCost({
      pgboss_job_id: null,
      outcome: 'success',
      task_kind: 'AttributionTask',
      cost: 0,
    });

    const resp = await getList(new Request('http://t/list'));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      jobs: Array<{
        pgboss_job_id: string;
        attempts: number;
        latest_outcome: string;
        total_cost: number;
      }>;
    };
    const ids = body.jobs.map((j) => j.pgboss_job_id);
    expect(ids).toContain('job-A');
    expect(ids).toContain('job-B');
    expect(ids).not.toContain(null);

    const jobA = body.jobs.find((j) => j.pgboss_job_id === 'job-A');
    expect(jobA?.attempts).toBe(2);
    expect(jobA?.latest_outcome).toBe('success');
    expect(jobA?.total_cost).toBeCloseTo(0.03);
  });

  it('respects limit query param', async () => {
    for (let i = 0; i < 5; i++) {
      await insertCost({
        pgboss_job_id: `job-${i}`,
        outcome: 'success',
        task_kind: 't',
        occurred_at: new Date(Date.now() - i * 1000),
      });
    }
    const resp = await getList(new Request('http://t/list?limit=2'));
    const body = (await resp.json()) as { jobs: unknown[] };
    expect(body.jobs).toHaveLength(2);
  });
});

describe('GET /api/_/logs/jobs/[id]', () => {
  it('returns summary + attempts for a known job', async () => {
    await insertCost({
      pgboss_job_id: 'job-X',
      outcome: 'failed_retryable',
      task_kind: 'tencent_ocr_extract',
      cost: 0.001,
    });
    await insertCost({
      pgboss_job_id: 'job-X',
      outcome: 'success',
      task_kind: 'tencent_ocr_extract',
      cost: 0.002,
      tokens_in: 200,
      tokens_out: 50,
    });

    const resp = await getById(new Request('http://t/x'), {
      params: Promise.resolve({ id: 'job-X' }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      summary: {
        attempts: number;
        latest_outcome: string;
        total_cost: number;
        total_tokens_in: number;
      };
      attempts: Array<{ outcome: string }>;
    };
    expect(body.summary.attempts).toBe(2);
    expect(body.summary.latest_outcome).toBe('success');
    expect(body.summary.total_cost).toBeCloseTo(0.003);
    expect(body.summary.total_tokens_in).toBe(200);
    expect(body.attempts).toHaveLength(2);
  });

  it('404 for unknown id', async () => {
    const resp = await getById(new Request('http://t/x'), {
      params: Promise.resolve({ id: 'never-existed' }),
    });
    expect(resp.status).toBe(404);
  });
});

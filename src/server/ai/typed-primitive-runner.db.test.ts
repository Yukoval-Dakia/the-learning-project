// YUK-1049 — typed primitive runner durable-truth db test.
//
// The wire transport is stubbed via fetchImpl (the ONLY external mock); the
// REAL AiRunLifecycle writers run against the container so ai_task_runs /
// cost_ledger rows prove: provider/model provenance, canonical typed-body
// input_hash, reported/estimated/unknown cost truth, and per-attempt rows.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ai_task_runs, cost_ledger } from '@/db/schema';
import { sha256Canonical } from '@/server/ai/task-input-hash';
import { runTypedPrimitiveTask } from '@/server/ai/typed-primitive-runner';
import { resetDb, testDb } from '../../../tests/helpers/db';

const KIND = 'JevScoringDecisionTask';
const BASE_INPUT = {
  state: { submission: { entries: [{ slot_id: 's1', kind: 'text', text_md: 'x = 4' }] } },
  questions: {
    u1: {
      type: 'noul',
      instructions: 'Is the answer correct?',
      criteria: { true: 'value is 4', false: 'value is not 4' },
    },
  },
};

const CANONICAL_BODY = {
  model: 'typesafe/jev-1.13',
  provider: {
    only: ['TypeSafe'],
    order: ['TypeSafe'],
    allow_fallbacks: false,
    max_price: { prompt: '0.042', completion: '0' },
  },
  ...BASE_INPUT,
};

function responseJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

const okBody = {
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  answers: { u1: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 120, output_tokens: 10, cost: 120 * 4.2e-8 },
};

beforeEach(async () => {
  await resetDb();
  vi.stubEnv('OPENROUTER_API_KEY', 'test-or-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runTypedPrimitiveTask — durable rows', () => {
  it('success writes one run row with typed provenance + reported cost ledger', async () => {
    const fetchImpl = vi.fn(async () => responseJson(okBody)) as unknown as typeof fetch;
    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, {
      db: testDb(),
      fetchImpl,
    });
    const runs = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, out.task_run_id));
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.task_kind).toBe(KIND);
    expect(run.provider).toBe('openrouter');
    expect(run.model).toBe('typesafe/jev-1.13');
    // Canonical typed-body fingerprint (state+questions+model+provider) —
    // provenance, NOT a composed-prompt hash.
    expect(run.input_hash).toBe(sha256Canonical(CANONICAL_BODY));
    expect(run.compiled_prompt_hash).toBeNull();
    expect(run.status).toBe('success');
    expect(run.usage_json.inputTokens).toBe(120);
    expect(run.cost_basis).toBe('reported');
    expect(run.cost_ref).toBe('openrouter:usage.cost');
    expect(run.cost_usd).toBeCloseTo(120 * 4.2e-8, 9);

    const ledger = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_run_id, out.task_run_id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].entry_kind).toBe('attempt');
    expect(ledger[0].cost_basis).toBe('reported');
    expect(ledger[0].cost).toBeCloseTo(120 * 4.2e-8, 9);
    expect(ledger[0].outcome).toBe('success');
  });

  it('permanent 401 writes failure rows with failed_permanent outcome', async () => {
    const fetchImpl = vi.fn(async () =>
      responseJson({ error: 'unauthorized' }, 401),
    ) as unknown as typeof fetch;
    await expect(
      runTypedPrimitiveTask(KIND, BASE_INPUT, { db: testDb(), fetchImpl }),
    ).rejects.toMatchObject({ subtype: 'api_error_result', apiErrorStatus: 401 });
    const runs = await testDb().select().from(ai_task_runs);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failure');
    expect(runs[0].provider).toBe('openrouter');
    const ledger = await testDb().select().from(cost_ledger);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe('failed_permanent');
  });

  it('missing usage ⇒ success row with unknown cost (amount NULL, never zero)', async () => {
    const body = { ...okBody } as Record<string, unknown>;
    delete body.usage;
    const fetchImpl = vi.fn(async () => responseJson(body)) as unknown as typeof fetch;
    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, { db: testDb(), fetchImpl });
    const runs = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, out.task_run_id));
    expect(runs[0].status).toBe('success');
    expect(runs[0].cost_basis).toBe('unknown');
    expect(runs[0].cost_usd).toBeNull();
    const ledger = await testDb().select().from(cost_ledger);
    expect(ledger[0].cost_basis).toBe('unknown');
    expect(ledger[0].cost).toBeNull();
  });
});

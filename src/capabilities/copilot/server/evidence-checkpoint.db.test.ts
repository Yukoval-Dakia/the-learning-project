import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { copilot_evidence_checkpoint, cost_ledger } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import type { CopilotEvidenceCheckpointBinding } from './evidence-checkpoint';
import { createPgCopilotEvidenceCheckpointStore } from './evidence-checkpoint-pg';

const db = testDb();
const binding: CopilotEvidenceCheckpointBinding = {
  task_kind: 'CopilotEvidenceReviewTask',
  slot: 'reference',
  protocol_version: 1,
  prompt_fingerprint: 'prompt-v1',
  base_input_sha256: 'a'.repeat(64),
  source_catalog_sha256: 'b'.repeat(64),
  binding_extras: { source_complete: 'true' },
};
const acceptedRecord = {
  kind: 'evidence_points' as const,
  points: [
    {
      request_unit_indices: [0],
      kind: 'observed_fact' as const,
      statement_md: 'Server-accepted exact fact.',
      sources: [{ source_id: 's1', role: 'value' as const }],
    },
  ],
};

describe('PgCopilotEvidenceCheckpointStore', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('deduplicates concurrent accepted appends and seals idempotently', async () => {
    const store = createPgCopilotEvidenceCheckpointStore(db);

    await Promise.all([
      store.appendRecords(binding, [acceptedRecord]),
      store.appendRecords(binding, [acceptedRecord]),
    ]);
    const loaded = await store.load(binding);
    expect(loaded).toMatchObject({ status: 'open', revision: 1, records: [acceptedRecord] });

    const sealed = {
      output_json: { protocol_version: 1 },
      digest_sha256: 'c'.repeat(64),
      task_run_id: 'successful-validator-run',
    };
    await expect(store.markSealed(binding, sealed)).resolves.toEqual({ status: 'ok' });
    await expect(store.markSealed(binding, sealed)).resolves.toEqual({ status: 'ok' });
    await expect(
      store.markSealed(binding, { ...sealed, task_run_id: 'different-run' }),
    ).resolves.toEqual({ status: 'conflict' });
  });

  it('expires checkpoints through the explicit cleanup path', async () => {
    const store = createPgCopilotEvidenceCheckpointStore(db);
    await store.appendRecords(binding, [acceptedRecord]);
    await db
      .update(copilot_evidence_checkpoint)
      .set({ expires_at: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(copilot_evidence_checkpoint.base_input_sha256, binding.base_input_sha256));

    await expect(store.cleanupExpired(new Date('2026-01-02T00:00:00.000Z'))).resolves.toBe(1);
    await expect(store.load(binding)).resolves.toBeUndefined();
    const [expired] = await db
      .select({
        status: copilot_evidence_checkpoint.status,
        records: copilot_evidence_checkpoint.records_json,
      })
      .from(copilot_evidence_checkpoint);
    expect(expired).toEqual({ status: 'expired', records: [] });
    await expect(store.appendRecords(binding, [acceptedRecord])).rejects.toThrow(
      'checkpoint expired',
    );
  });

  it('keeps each paid attempt outcome, tokens, and cost as separate audit truth', async () => {
    const store = createPgCopilotEvidenceCheckpointStore(db);
    const attempts = [
      {
        task_run_id: 'validator-retryable',
        outcome: 'failed_retryable' as const,
        failure_kind: 'stream_no_terminal',
        finished_at: '2026-08-26T00:00:01.000Z',
        tokens_in: 15_000,
        tokens_out: 900,
        cost: 0.14,
      },
      {
        task_run_id: 'validator-permanent',
        outcome: 'failed_permanent' as const,
        failure_kind: 'runner_error',
        finished_at: '2026-08-26T00:00:02.000Z',
        tokens_in: 16_000,
        tokens_out: 300,
        cost: 0.11,
      },
      {
        task_run_id: 'validator-success',
        outcome: 'success' as const,
        finished_at: '2026-08-26T00:00:03.000Z',
        tokens_in: 4_000,
        tokens_out: 600,
        cost: 0.05,
      },
    ];
    for (const attempt of attempts) {
      await store.recordAttempt(binding, {
        outcome: 'running',
        task_run_id: attempt.task_run_id,
        task_input_sha256: 'd'.repeat(64),
        started_at: new Date(Date.parse(attempt.finished_at) - 1_000).toISOString(),
      });
      await store.recordAttempt(binding, {
        outcome: attempt.outcome,
        ...(attempt.failure_kind ? { failure_kind: attempt.failure_kind } : {}),
        task_run_id: attempt.task_run_id,
        task_input_sha256: 'd'.repeat(64),
        finished_at: attempt.finished_at,
      });
      await db.insert(cost_ledger).values({
        id: `cost-${attempt.task_run_id}`,
        task_run_id: attempt.task_run_id,
        task_kind: 'CopilotEvidenceReviewTask',
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        cost: attempt.cost,
        currency: 'USD',
        entry_kind: 'attempt',
        cost_basis: 'reported',
        cost_ref: `provider:${attempt.task_run_id}`,
        tokens_in: attempt.tokens_in,
        tokens_out: attempt.tokens_out,
        outcome: attempt.outcome,
        occurred_at: new Date(attempt.finished_at),
      });
    }

    const checkpoint = await store.load(binding);
    const ledger = await db
      .select({
        task_run_id: cost_ledger.task_run_id,
        outcome: cost_ledger.outcome,
        tokens_in: cost_ledger.tokens_in,
        tokens_out: cost_ledger.tokens_out,
        cost: cost_ledger.cost,
      })
      .from(cost_ledger);
    expect(checkpoint?.attempts).toHaveLength(3);
    expect(ledger).toEqual(
      expect.arrayContaining(
        attempts.map((attempt) => ({
          task_run_id: attempt.task_run_id,
          outcome: attempt.outcome,
          tokens_in: attempt.tokens_in,
          tokens_out: attempt.tokens_out,
          cost: attempt.cost,
        })),
      ),
    );
  });
});

import { ai_task_runs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { persistValidatorRunBinding } from './sealed-validation';

const db = testDb();
const inputHash = 'a'.repeat(64);
const promptFingerprint = 'b'.repeat(64);
const resultDigest = 'c'.repeat(64);

async function seedRun(overrides: Partial<typeof ai_task_runs.$inferInsert> = {}) {
  await db.insert(ai_task_runs).values({
    id: 'sealed_validator_run',
    task_kind: 'CopilotEvidenceVerificationTask',
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    input_hash: inputHash,
    status: 'success',
    finish_reason: 'stop',
    usage_json: { inputTokens: 16_000, outputTokens: 2_400 },
    started_at: new Date('2026-08-02T00:00:00.000Z'),
    finished_at: new Date('2026-08-02T00:00:45.000Z'),
    ...overrides,
  });
}

describe('persistValidatorRunBinding', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('binds the exact successful task row to prompt, input, and result digests', async () => {
    await seedRun();

    await persistValidatorRunBinding(db, {
      taskRunId: 'sealed_validator_run',
      taskKind: 'CopilotEvidenceVerificationTask',
      taskInputSha256: inputHash,
      promptFingerprint,
      resultDigest,
    });

    const [row] = await db
      .select({
        prompt_fingerprint: ai_task_runs.prompt_fingerprint,
        result_digest: ai_task_runs.result_digest,
      })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, 'sealed_validator_run'));
    expect(row).toEqual({ prompt_fingerprint: promptFingerprint, result_digest: resultDigest });
  });

  it('fails closed when the task input hash does not name the paid run', async () => {
    await seedRun();

    await expect(
      persistValidatorRunBinding(db, {
        taskRunId: 'sealed_validator_run',
        taskKind: 'CopilotEvidenceVerificationTask',
        taskInputSha256: 'd'.repeat(64),
        promptFingerprint,
        resultDigest,
      }),
    ).rejects.toThrow('did not match one successful task run');

    const [row] = await db
      .select({
        prompt_fingerprint: ai_task_runs.prompt_fingerprint,
        result_digest: ai_task_runs.result_digest,
      })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, 'sealed_validator_run'));
    expect(row).toEqual({ prompt_fingerprint: null, result_digest: null });
  });
});

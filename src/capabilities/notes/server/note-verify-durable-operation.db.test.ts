// Real-Postgres proofs of the DBOS no-repurchase contract against the real
// note_verification_claim tables: a crashed durable execution is simulated by
// seeding the claim row in the state a DBOS step recovery would find, then
// re-entering through the operation.
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noteSectionsToBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import type { Db } from '@/db/client';
import { artifact, note_verification_claim } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runNoteVerify } from './note-verify-durable-operation';

const SECTIONS = ['definition', 'mechanism', 'example', 'pitfall', 'check'].map((kind, index) => ({
  id: `s${index}`,
  kind,
  body_md: `${kind} content`,
  source_tier: 'llm_only',
  user_verified: false,
  embedded_check: null,
  version: 1,
}));

const PASS_OUTPUT = JSON.stringify({
  verdict: 'pass',
  summary_md: 'verified',
  issues: [],
  confidence: 0.9,
});

async function crossProviderBoundary(
  ctx: Parameters<Parameters<typeof runNoteVerify>[0]['runTaskFn']>[2],
): Promise<void> {
  if (!ctx?.taskRunId || !ctx?.beforeProviderQuery) {
    throw new Error('provider boundary callback missing');
  }
  await ctx.beforeProviderQuery({
    taskRunId: ctx.taskRunId,
    provider: 'anthropic-sub',
    model: 'test',
  });
}

async function seedArtifact(id: string, version = 0, db: Db = testDb()): Promise<void> {
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'note_atomic',
    title: id,
    knowledge_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    body_blocks: noteSectionsToBodyBlocks(SECTIONS as never),
    attrs: {},
    generation_status: 'ready',
    verification_status: 'queued',
    history: [],
    created_at: now,
    updated_at: now,
    version,
  });
}

/** Seed the claim row exactly as a crashed execution would have left it. */
async function seedCrashedClaim(
  db: Db,
  artifactId: string,
  state: 'provider_started' | 'result_ready' | 'retry_wait',
  overrides: {
    leaseExpiresAt?: Date;
    resultJson?: Record<string, unknown>;
    providerAttempts?: number;
  } = {},
): Promise<void> {
  const now = new Date();
  await db.insert(note_verification_claim).values({
    artifact_id: artifactId,
    artifact_version: 0,
    state,
    fence: 1,
    claim_token: state === 'retry_wait' ? null : '0b1f2b3c-4d5e-6f70-8a9b-0c1d2e3f4a5b',
    task_run_id: state === 'retry_wait' ? null : `${artifactId}_run_1`,
    result_json: overrides.resultJson ?? null,
    provider_attempts: overrides.providerAttempts ?? 1,
    error_message: state === 'retry_wait' ? 'simulated released failure' : null,
    available_at: state === 'retry_wait' ? new Date(now.getTime() - 1_000) : now,
    lease_expires_at: overrides.leaseExpiresAt ?? null,
    claimed_at: now,
    provider_started_at: state === 'provider_started' ? now : null,
    result_ready_at: state === 'result_ready' ? now : null,
    created_at: now,
    updated_at: now,
  });
}

async function claimRow(db: Db, artifactId: string) {
  const rows = await db
    .select()
    .from(note_verification_claim)
    .where(eq(note_verification_claim.artifact_id, artifactId))
    .limit(1);
  return rows[0];
}

describe('note-verify durable operation recovery re-entry (DBOS no-repurchase)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant concurrency: a recovered durable execution re-entering an in-flight provider_started claim must not purchase a new claim or re-run the paid provider call
  // @fails-if the operation re-reserves or invokes runTaskFn while the claim is provider_started with an unexpired lease, double-spending the provider attempt
  it('re-entry while provider_started with an unexpired lease stays busy without a new paid call', async () => {
    await seedArtifact('recover-live');
    await seedCrashedClaim(testDb(), 'recover-live', 'provider_started', {
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'recover-live', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:in_progress' });
    expect(runTaskFn).not.toHaveBeenCalled();
    expect((await claimRow(testDb(), 'recover-live'))?.state).toBe('provider_started');
  });

  // @invariant concurrency: an expired provider_started lease terminalizes to ambiguous on re-entry instead of starting another paid attempt
  // @fails-if the operation re-reserves the expired claim or re-invokes runTaskFn, replaying an unknown paid outcome as a new provider call
  it('re-entry after lease expiry marks ambiguous without repurchasing', async () => {
    await seedArtifact('recover-expired');
    await seedCrashedClaim(testDb(), 'recover-expired', 'provider_started', {
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });
    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'recover-expired', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:ambiguous' });
    expect(runTaskFn).not.toHaveBeenCalled();
    expect((await claimRow(testDb(), 'recover-expired'))?.state).toBe('ambiguous');
  });

  // @invariant data: a staged raw result is finalized into the artifact exactly once without any further provider call
  // @fails-if the finalize path invokes runTaskFn or a second re-entry re-persists the verification outcome for the same epoch
  it('re-entry at result_ready finalizes exactly once with no provider call', async () => {
    await seedArtifact('recover-staged');
    await seedCrashedClaim(testDb(), 'recover-staged', 'result_ready', {
      resultJson: { kind: 'provider_result', taskResult: { text: PASS_OUTPUT } },
    });
    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'recover-staged', runTaskFn }),
    ).resolves.toMatchObject({ status: 'verified', artifact_type: 'note_atomic' });
    const artifactRows = await testDb()
      .select({ verificationStatus: artifact.verification_status })
      .from(artifact)
      .where(eq(artifact.id, 'recover-staged'))
      .limit(1);
    expect(artifactRows[0]?.verificationStatus).toBe('verified');
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'recover-staged', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:not_queued' });
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  // @invariant concurrency: the per-epoch provider attempt budget is shared across backends, so a retry_wait re-entry continues the existing count instead of resetting it
  // @fails-if the operation bypasses the shared claim counter or double-increments provider_attempts for one provider call
  it('retry_wait re-entry reserves a legitimate new attempt on the shared budget', async () => {
    await seedArtifact('recover-retry');
    await seedCrashedClaim(testDb(), 'recover-retry', 'retry_wait', { providerAttempts: 1 });
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      return { text: PASS_OUTPUT };
    });
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'recover-retry', runTaskFn }),
    ).resolves.toMatchObject({ status: 'verified' });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const claim = await claimRow(testDb(), 'recover-retry');
    expect(claim?.state).toBe('completed');
    expect(claim?.provider_attempts).toBe(2);
  });
});

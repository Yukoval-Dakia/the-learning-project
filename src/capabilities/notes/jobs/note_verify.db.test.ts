import { noteSectionsToBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import {
  markNoteVerificationProviderStarted,
  reserveNoteVerification,
  stageNoteVerificationResult,
} from '@/capabilities/notes/server/note-verification-claim';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { ai_task_runs, artifact, event, note_verification_claim } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  type RunTaskFn,
  buildNoteVerifyHandler,
  recoverResultReadyNoteVerifications,
  runNoteVerify,
} from './note_verify';

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

function fakeBoss() {
  const jobs = new Map<string, { readonly state: string }>();
  const send = vi.fn(async (_queue: string, _data: object, options: { id: string }) => {
    jobs.set(options.id, { state: 'created' });
    return options.id;
  });
  const getJobById = vi.fn(async (_queue: string, id: string) => jobs.get(id) ?? null);
  return { jobs, send, getJobById };
}

async function crossProviderBoundary(ctx: Parameters<RunTaskFn>[2]): Promise<void> {
  if (!ctx?.taskRunId || !ctx.beforeProviderQuery) {
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

describe('runNoteVerify durable claim', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('completes once and exits before AI on redelivery', async () => {
    await seedArtifact('completed');
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      return { text: PASS_OUTPUT };
    });
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'completed', runTaskFn }),
    ).resolves.toMatchObject({ status: 'verified' });
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'completed', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:not_queued' });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const [claim] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'completed'));
    expect(claim.state).toBe('completed');
    expect(claim.provider_attempts).toBe(1);
  });

  it('keeps no-sections deliveries skipped without leaving a recoverable claim', async () => {
    await seedArtifact('no-sections');
    await testDb()
      .update(artifact)
      .set({ body_blocks: { type: 'doc', content: [] } })
      .where(eq(artifact.id, 'no-sections'));
    const runTaskFn = vi.fn();

    for (let delivery = 0; delivery < 2; delivery += 1) {
      await expect(
        runNoteVerify({ db: testDb(), artifactId: 'no-sections', runTaskFn }),
      ).resolves.toMatchObject({ status: 'skipped:no_sections' });
      const claims = await testDb()
        .select({ artifactId: note_verification_claim.artifact_id })
        .from(note_verification_claim)
        .where(eq(note_verification_claim.artifact_id, 'no-sections'));
      expect(claims).toEqual([]);
    }
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('skips archived and terminal deliveries without creating claims or calling AI', async () => {
    await seedArtifact('archived-delivery');
    await seedArtifact('verified-delivery');
    await testDb()
      .update(artifact)
      .set({ archived_at: new Date() })
      .where(eq(artifact.id, 'archived-delivery'));
    await testDb()
      .update(artifact)
      .set({ verification_status: 'verified' })
      .where(eq(artifact.id, 'verified-delivery'));
    const runTaskFn = vi.fn();

    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'archived-delivery', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:not_queued' });
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'verified-delivery', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:not_queued' });

    expect(runTaskFn).not.toHaveBeenCalled();
    const claims = await testDb().select().from(note_verification_claim);
    expect(claims).toEqual([]);
  });

  it('skips a queued tool artifact without AI, claim creation, or mutation', async () => {
    await seedArtifact('tool-verification');
    await testDb()
      .update(artifact)
      .set({ type: 'tool_quiz' })
      .where(eq(artifact.id, 'tool-verification'));
    const runTaskFn = vi.fn();

    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'tool-verification', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:not_queued' });

    expect(runTaskFn).not.toHaveBeenCalled();
    const claims = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'tool-verification'));
    expect(claims).toEqual([]);
    const [row] = await testDb()
      .select({
        type: artifact.type,
        status: artifact.verification_status,
        version: artifact.version,
      })
      .from(artifact)
      .where(eq(artifact.id, 'tool-verification'));
    expect(row).toEqual({ type: 'tool_quiz', status: 'queued', version: 0 });
  });

  it('drops a reservation when the artifact is archived before the provider boundary', async () => {
    await seedArtifact('archived-before-provider');
    const db = testDb();
    let providerQueries = 0;
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await db
        .update(artifact)
        .set({ archived_at: new Date() })
        .where(eq(artifact.id, 'archived-before-provider'));
      await crossProviderBoundary(ctx);
      providerQueries += 1;
      return { text: PASS_OUTPUT };
    });

    await expect(
      runNoteVerify({ db, artifactId: 'archived-before-provider', runTaskFn }),
    ).rejects.toThrow('provider-start claim changed');

    expect(providerQueries).toBe(0);
    const claims = await db
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'archived-before-provider'));
    expect(claims).toEqual([]);
  });

  it('fences concurrent delivery to exactly one paid call', async () => {
    await seedArtifact('concurrent');
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      await wait;
      return { text: PASS_OUTPUT };
    });
    const first = runNoteVerify({ db: testDb(), artifactId: 'concurrent', runTaskFn });
    await vi.waitFor(() => expect(runTaskFn).toHaveBeenCalledTimes(1));
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'concurrent', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:in_progress' });
    release?.();
    await expect(first).resolves.toMatchObject({ status: 'verified' });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('keeps a live duplicate delivery retry-visible at the handler boundary', async () => {
    await seedArtifact('busy-handler');
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      await wait;
      return { text: PASS_OUTPUT };
    });
    const first = runNoteVerify({ db: testDb(), artifactId: 'busy-handler', runTaskFn });
    await vi.waitFor(() => expect(runTaskFn).toHaveBeenCalledTimes(1));
    const handler = buildNoteVerifyHandler(testDb(), { runTaskFn });
    await expect(
      handler([{ id: 'redelivery', data: { artifact_id: 'busy-handler' } } as never]),
    ).rejects.toThrow('retry required');
    release?.();
    await expect(first).resolves.toMatchObject({ status: 'verified' });
  });

  it('does not hold a database transaction connection over AI', async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL not set');
    const client = postgres(url, { max: 1 });
    const dedicatedDb: Db = drizzle(client, { schema });
    let release: (() => void) | undefined;
    let running: Promise<unknown> | undefined;
    let probe: Promise<Array<{ id: string }>> | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      await wait;
      return { text: PASS_OUTPUT };
    });
    try {
      await seedArtifact('pool-safe', 0, dedicatedDb);
      running = runNoteVerify({ db: dedicatedDb, artifactId: 'pool-safe', runTaskFn });
      await vi.waitFor(() => expect(runTaskFn).toHaveBeenCalledTimes(1));
      probe = dedicatedDb
        .select({ id: artifact.id })
        .from(artifact)
        .where(eq(artifact.id, 'pool-safe'))
        .execute();
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      const probeResult = await Promise.race([
        probe.then((rows) => ({ kind: 'rows' as const, rows })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          probeTimer = setTimeout(() => resolve({ kind: 'timeout' }), 2_000);
        }),
      ]).finally(() => {
        if (probeTimer) clearTimeout(probeTimer);
      });
      expect(probeResult).toEqual({ kind: 'rows', rows: [{ id: 'pool-safe' }] });
    } finally {
      release?.();
      const pending: Promise<unknown>[] = [];
      if (running) pending.push(running);
      if (probe) pending.push(probe);
      await Promise.allSettled(pending);
      await client.end();
    }
  });

  it('retries a pre-wire startup failure without consuming a provider attempt', async () => {
    await seedArtifact('pre-wire');
    const startupFailure = vi.fn(async () => {
      throw new Error('sdk startup failed');
    });

    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'pre-wire', runTaskFn: startupFailure }),
    ).rejects.toThrow('sdk startup failed');
    const [released] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'pre-wire'));
    expect(released).toMatchObject({
      state: 'retry_wait',
      provider_attempts: 0,
      provider_started_at: null,
      task_run_id: null,
    });
    const taskRuns = await testDb()
      .select({ id: ai_task_runs.id })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.task_kind, 'NoteVerifyTask'));
    expect(taskRuns).toEqual([]);

    await testDb()
      .update(note_verification_claim)
      .set({ available_at: new Date(0) })
      .where(eq(note_verification_claim.artifact_id, 'pre-wire'));
    const successfulRetry = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      return { text: PASS_OUTPUT };
    });
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'pre-wire', runTaskFn: successfulRetry }),
    ).resolves.toMatchObject({ status: 'verified' });
    const [completed] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'pre-wire'));
    expect(completed.provider_attempts).toBe(1);
  });

  it('recovery redispatches an exhausted confirmed-failure retry without another AI call', async () => {
    await seedArtifact('retry');
    let calls = 0;
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      calls += 1;
      await crossProviderBoundary(ctx);
      if (calls > 1) return { text: PASS_OUTPUT };
      const now = new Date();
      await testDb()
        .insert(ai_task_runs)
        .values({
          id: ctx.taskRunId ?? 'missing',
          task_kind: 'NoteVerifyTask',
          provider: 'test',
          model: 'test',
          input_hash: 'test',
          status: 'failure',
          finish_reason: 'error',
          error_message: 'transient',
          started_at: now,
          finished_at: now,
        });
      throw new Error('transient');
    });
    await expect(runNoteVerify({ db: testDb(), artifactId: 'retry', runTaskFn })).rejects.toThrow(
      'transient',
    );
    const [claim] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'retry'));
    expect(claim.state).toBe('retry_wait');
    expect(claim.claim_token).toBeNull();
    expect(claim.task_run_id).toBeNull();
    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, 'retry'));
    expect(row.verification_status).toBe('queued');
    await testDb()
      .update(note_verification_claim)
      .set({ available_at: new Date(0) })
      .where(eq(note_verification_claim.artifact_id, 'retry'));
    const boss = fakeBoss();
    await expect(recoverResultReadyNoteVerifications(testDb(), { boss })).resolves.toBe(0);
    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      'note_verify',
      { artifact_id: 'retry' },
      { id: expect.any(String) },
    );
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'retry', runTaskFn }),
    ).resolves.toMatchObject({ status: 'verified' });
    expect(runTaskFn).toHaveBeenCalledTimes(2);
  });

  it('fails closed when provider start cannot be reconciled', async () => {
    await seedArtifact('ambiguous');
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      throw new Error('connection lost after start');
    });
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'ambiguous', runTaskFn }),
    ).rejects.toThrow('connection lost');
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'ambiguous', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:ambiguous' });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const [claim] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'ambiguous'));
    expect(claim).toMatchObject({ state: 'ambiguous', provider_attempts: 1 });
  });

  it('acknowledges an archived delivery even when its paid result remains ambiguous', async () => {
    await seedArtifact('archived-ambiguous');
    const firstRunTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      throw new Error('connection lost after start');
    });
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'archived-ambiguous', runTaskFn: firstRunTaskFn }),
    ).rejects.toThrow('connection lost');
    await testDb()
      .update(artifact)
      .set({ archived_at: new Date() })
      .where(eq(artifact.id, 'archived-ambiguous'));
    const redeliveryRunTaskFn = vi.fn();
    const handler = buildNoteVerifyHandler(testDb(), { runTaskFn: redeliveryRunTaskFn });

    await expect(
      handler([{ id: 'archived-ambiguous', data: { artifact_id: 'archived-ambiguous' } } as never]),
    ).resolves.toBeUndefined();

    expect(redeliveryRunTaskFn).not.toHaveBeenCalled();
    const [claim] = await testDb()
      .select({ state: note_verification_claim.state })
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'archived-ambiguous'));
    expect(claim.state).toBe('ambiguous');
  });

  it('caps persistent confirmed failures at three provider starts across recovery jobs', async () => {
    await seedArtifact('attempt-cap');
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      const now = new Date();
      await testDb()
        .insert(ai_task_runs)
        .values({
          id: ctx.taskRunId ?? 'missing',
          task_kind: 'NoteVerifyTask',
          provider: 'test',
          model: 'test',
          input_hash: 'test',
          status: 'failure',
          finish_reason: 'error',
          error_message: 'persistent failure',
          started_at: now,
          finished_at: now,
        });
      throw new Error('persistent failure');
    });
    const boss = fakeBoss();

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await expect(
        runNoteVerify({ db: testDb(), artifactId: 'attempt-cap', runTaskFn }),
      ).rejects.toThrow('persistent failure');
      const [claim] = await testDb()
        .select()
        .from(note_verification_claim)
        .where(eq(note_verification_claim.artifact_id, 'attempt-cap'));
      expect(claim.provider_attempts).toBe(attempt);
      expect(claim.state).toBe('retry_wait');
      await testDb()
        .update(note_verification_claim)
        .set({ available_at: new Date(0) })
        .where(eq(note_verification_claim.artifact_id, 'attempt-cap'));
      await expect(recoverResultReadyNoteVerifications(testDb(), { boss })).resolves.toBe(0);
    }

    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'attempt-cap', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:attempts_exhausted' });

    expect(runTaskFn).toHaveBeenCalledTimes(3);
    expect(boss.send).toHaveBeenCalledTimes(2);
    const [exhausted] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'attempt-cap'));
    const [failedArtifact] = await testDb()
      .select({ verificationStatus: artifact.verification_status })
      .from(artifact)
      .where(eq(artifact.id, 'attempt-cap'));
    const lifecycleEvents = await testDb()
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.subject_id, 'attempt-cap'),
          eq(event.action, 'experimental:artifact_lifecycle'),
        ),
      );
    expect(exhausted).toMatchObject({
      state: 'attempts_exhausted',
      provider_attempts: 3,
      provider_started_at: null,
      task_run_id: null,
    });
    expect(failedArtifact.verificationStatus).toBe('failed');
    expect(lifecycleEvents).toContainEqual({
      payload: expect.objectContaining({
        op: 'set_verification_status',
        verification_status: 'failed',
      }),
    });
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'attempt-cap', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:attempts_exhausted' });
    expect(runTaskFn).toHaveBeenCalledTimes(3);
  });

  it('resets the provider-attempt budget only for a new artifact epoch', async () => {
    await seedArtifact('new-epoch', 1);
    const now = new Date();
    await testDb().insert(note_verification_claim).values({
      artifact_id: 'new-epoch',
      artifact_version: 0,
      state: 'attempts_exhausted',
      provider_attempts: 3,
      error_message: 'provider attempt limit reached',
      available_at: now,
      created_at: now,
      updated_at: now,
    });
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      return { text: PASS_OUTPUT };
    });

    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'new-epoch', runTaskFn }),
    ).resolves.toMatchObject({ status: 'verified' });
    const [claim] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'new-epoch'));
    expect(claim).toMatchObject({ artifact_version: 1, provider_attempts: 1, state: 'completed' });
  });

  it('repairs a queued artifact already paired with an exhausted current-epoch claim', async () => {
    await seedArtifact('exhausted-redelivery');
    const now = new Date();
    await testDb().insert(note_verification_claim).values({
      artifact_id: 'exhausted-redelivery',
      artifact_version: 0,
      state: 'attempts_exhausted',
      provider_attempts: 3,
      error_message: 'provider attempt limit reached',
      available_at: now,
      created_at: now,
      updated_at: now,
    });
    const runTaskFn = vi.fn();

    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'exhausted-redelivery', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:attempts_exhausted' });

    const [failedArtifact] = await testDb()
      .select({ verificationStatus: artifact.verification_status })
      .from(artifact)
      .where(eq(artifact.id, 'exhausted-redelivery'));
    expect(failedArtifact.verificationStatus).toBe('failed');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('acks a provider-start cap race without submitting a query or leaving the artifact queued', async () => {
    await seedArtifact('cap-at-boundary');
    let submittedQueries = 0;
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await testDb()
        .update(note_verification_claim)
        .set({ provider_attempts: 3 })
        .where(eq(note_verification_claim.artifact_id, 'cap-at-boundary'));
      await crossProviderBoundary(ctx);
      submittedQueries += 1;
      return { text: PASS_OUTPUT };
    });

    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'cap-at-boundary', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:attempts_exhausted' });

    const [claim] = await testDb()
      .select({ state: note_verification_claim.state })
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'cap-at-boundary'));
    const [failedArtifact] = await testDb()
      .select({ verificationStatus: artifact.verification_status })
      .from(artifact)
      .where(eq(artifact.id, 'cap-at-boundary'));
    expect(claim.state).toBe('attempts_exhausted');
    expect(failedArtifact.verificationStatus).toBe('failed');
    expect(submittedQueries).toBe(0);
  });

  it('finalizes durable result_ready without a second AI call', async () => {
    await seedArtifact('result-ready');
    const reservation = await reserveNoteVerification(testDb(), 'result-ready');
    if (reservation.kind !== 'claimed') throw new Error('expected claim');
    await markNoteVerificationProviderStarted(testDb(), reservation.lease);
    await stageNoteVerificationResult(testDb(), reservation.lease, {
      kind: 'provider_result',
      taskResult: { text: PASS_OUTPUT, task_run_id: reservation.lease.taskRunId },
    });
    await expect(recoverResultReadyNoteVerifications(testDb())).resolves.toBe(1);
    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, 'result-ready'));
    expect(row.verification_status).toBe('verified');
  });

  it('continues a recovery batch after one item fails, then rejects the batch', async () => {
    await seedArtifact('batch-a-bad');
    await seedArtifact('batch-b-good');
    const bad = await reserveNoteVerification(testDb(), 'batch-a-bad');
    const good = await reserveNoteVerification(testDb(), 'batch-b-good');
    if (bad.kind !== 'claimed' || good.kind !== 'claimed') throw new Error('expected claims');
    await markNoteVerificationProviderStarted(testDb(), bad.lease);
    await markNoteVerificationProviderStarted(testDb(), good.lease);
    await stageNoteVerificationResult(testDb(), bad.lease, {
      kind: 'provider_result',
      taskResult: { text: 'not-json', task_run_id: bad.lease.taskRunId },
    });
    await stageNoteVerificationResult(testDb(), good.lease, {
      kind: 'provider_result',
      taskResult: { text: PASS_OUTPUT, task_run_id: good.lease.taskRunId },
    });

    await expect(recoverResultReadyNoteVerifications(testDb())).rejects.toThrow(
      'note verification recovery batch failed',
    );
    const [badClaim] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'batch-a-bad'));
    const [goodArtifact] = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, 'batch-b-good'));
    expect(badClaim.state).toBe('retry_wait');
    expect(goodArtifact.verification_status).toBe('verified');
  });

  it('filters fifty terminal claims before the recovery limit', async () => {
    const db = testDb();
    for (let index = 0; index < 50; index += 1) {
      const artifactId = `terminal-claim-${String(index).padStart(2, '0')}`;
      await seedArtifact(artifactId);
      const reservation = await reserveNoteVerification(db, artifactId);
      if (reservation.kind !== 'claimed') throw new Error('expected terminal seed claim');
      await db
        .update(artifact)
        .set({ verification_status: 'verified' })
        .where(eq(artifact.id, artifactId));
      await db
        .update(note_verification_claim)
        .set({
          state: 'retry_wait',
          claim_token: null,
          task_run_id: null,
          claimed_at: null,
          lease_expires_at: null,
          available_at: new Date(0),
        })
        .where(eq(note_verification_claim.artifact_id, artifactId));
    }
    await seedArtifact('valid-after-terminal-claims');
    const valid = await reserveNoteVerification(db, 'valid-after-terminal-claims');
    if (valid.kind !== 'claimed') throw new Error('expected valid recovery claim');
    await db
      .update(note_verification_claim)
      .set({ lease_expires_at: new Date(0), available_at: new Date(0) })
      .where(eq(note_verification_claim.artifact_id, 'valid-after-terminal-claims'));
    const boss = fakeBoss();

    await expect(recoverResultReadyNoteVerifications(db, { boss })).resolves.toBe(0);

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      'note_verify',
      { artifact_id: 'valid-after-terminal-claims' },
      expect.objectContaining({ id: expect.any(String) }),
    );
  });

  it('filters fifty non-note claims before the recovery limit', async () => {
    const db = testDb();
    for (let index = 0; index < 50; index += 1) {
      const artifactId = `tool-claim-${String(index).padStart(2, '0')}`;
      await seedArtifact(artifactId);
      const reservation = await reserveNoteVerification(db, artifactId);
      if (reservation.kind !== 'claimed') throw new Error('expected tool seed claim');
      await db.update(artifact).set({ type: 'tool_quiz' }).where(eq(artifact.id, artifactId));
      await db
        .update(note_verification_claim)
        .set({
          state: 'retry_wait',
          claim_token: null,
          task_run_id: null,
          claimed_at: null,
          lease_expires_at: null,
          available_at: new Date(0),
        })
        .where(eq(note_verification_claim.artifact_id, artifactId));
    }
    await seedArtifact('valid-after-tool-claims');
    const valid = await reserveNoteVerification(db, 'valid-after-tool-claims');
    if (valid.kind !== 'claimed') throw new Error('expected valid recovery claim');
    await db
      .update(note_verification_claim)
      .set({ lease_expires_at: new Date(0), available_at: new Date(0) })
      .where(eq(note_verification_claim.artifact_id, 'valid-after-tool-claims'));
    const boss = fakeBoss();

    await expect(recoverResultReadyNoteVerifications(db, { boss })).resolves.toBe(0);

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      'note_verify',
      { artifact_id: 'valid-after-tool-claims' },
      expect.objectContaining({ id: expect.any(String) }),
    );
  });

  it('cron requeues an expired pre-provider reservation and the handler completes it', async () => {
    await seedArtifact('expired-reserved');
    const first = await reserveNoteVerification(testDb(), 'expired-reserved');
    if (first.kind !== 'claimed') throw new Error('expected claim');
    await testDb()
      .update(note_verification_claim)
      .set({ lease_expires_at: new Date(0) })
      .where(eq(note_verification_claim.artifact_id, 'expired-reserved'));
    const boss = fakeBoss();
    await expect(recoverResultReadyNoteVerifications(testDb(), { boss })).resolves.toBe(0);
    expect(boss.send).toHaveBeenCalledTimes(1);
    const [recovered] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'expired-reserved'));
    expect(recovered.state).toBe('retry_wait');
    expect(recovered.claim_token).toBeNull();
    expect(recovered.fence).toBeGreaterThan(first.lease.fence);
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      return { text: PASS_OUTPUT };
    });
    const handler = buildNoteVerifyHandler(testDb(), { runTaskFn });
    await expect(
      handler([{ id: 'claim-recovery', data: { artifact_id: 'expired-reserved' } } as never]),
    ).resolves.toBeUndefined();
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('rediscovers a pre-wire recovery dispatch after send and readback both fail', async () => {
    await seedArtifact('recovery-lost-ack');
    const reservation = await reserveNoteVerification(testDb(), 'recovery-lost-ack');
    if (reservation.kind !== 'claimed') throw new Error('expected claim');
    await testDb()
      .update(note_verification_claim)
      .set({ lease_expires_at: new Date(0) })
      .where(eq(note_verification_claim.artifact_id, 'recovery-lost-ack'));
    const boss = fakeBoss();
    boss.send.mockRejectedValueOnce(new Error('send unavailable'));
    boss.getJobById.mockRejectedValueOnce(new Error('readback unavailable'));
    await expect(recoverResultReadyNoteVerifications(testDb(), { boss })).rejects.toThrow(
      'note verification recovery batch failed',
    );
    const [pendingRetry] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'recovery-lost-ack'));
    expect(pendingRetry).toMatchObject({
      state: 'retry_wait',
      task_run_id: null,
      result_json: null,
    });
    await expect(recoverResultReadyNoteVerifications(testDb(), { boss })).resolves.toBe(0);
    expect(boss.send).toHaveBeenCalledTimes(2);
    expect(boss.send.mock.calls[0]?.[2].id).toBe(boss.send.mock.calls[1]?.[2].id);
    expect(boss.jobs.size).toBe(1);
  });

  it('turns an expired provider-start lease ambiguous without retrying wire', async () => {
    await seedArtifact('expired-provider');
    const reservation = await reserveNoteVerification(testDb(), 'expired-provider');
    if (reservation.kind !== 'claimed') throw new Error('expected claim');
    await markNoteVerificationProviderStarted(testDb(), reservation.lease);
    await testDb()
      .update(note_verification_claim)
      .set({ lease_expires_at: new Date(0) })
      .where(eq(note_verification_claim.artifact_id, 'expired-provider'));
    const boss = fakeBoss();
    await expect(recoverResultReadyNoteVerifications(testDb(), { boss })).resolves.toBe(0);
    const runTaskFn = vi.fn();
    const handler = buildNoteVerifyHandler(testDb(), { runTaskFn });
    await expect(
      handler([{ id: 'expired-provider', data: { artifact_id: 'expired-provider' } } as never]),
    ).rejects.toThrow('retry required');
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('bounds malformed durable-result retries without another paid call', async () => {
    await seedArtifact('bad-result');
    const reservation = await reserveNoteVerification(testDb(), 'bad-result');
    if (reservation.kind !== 'claimed') throw new Error('expected claim');
    await markNoteVerificationProviderStarted(testDb(), reservation.lease);
    await stageNoteVerificationResult(testDb(), reservation.lease, {
      kind: 'provider_result',
      taskResult: { text: 'not-json' },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(recoverResultReadyNoteVerifications(testDb())).rejects.toThrow(
        'note verification recovery batch failed',
      );
      const [deferred] = await testDb()
        .select()
        .from(note_verification_claim)
        .where(eq(note_verification_claim.artifact_id, 'bad-result'));
      expect(deferred.state).toBe('retry_wait');
      expect(deferred.result_json).not.toBeNull();
      await testDb()
        .update(note_verification_claim)
        .set({ available_at: new Date(0) })
        .where(eq(note_verification_claim.artifact_id, 'bad-result'));
    }
    await expect(recoverResultReadyNoteVerifications(testDb())).resolves.toBe(0);
    const [claim] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'bad-result'));
    expect(claim.state).toBe('ambiguous');
    expect(claim.result_attempts).toBe(2);
    const taskRuns = await testDb()
      .select({ id: ai_task_runs.id })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, reservation.lease.taskRunId));
    expect(taskRuns).toEqual([]);
  });

  it('makes an epoch change after provider start retry-visible and verifies the new epoch', async () => {
    await seedArtifact('stale');
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      calls += 1;
      if (calls === 1) await wait;
      return { text: PASS_OUTPUT };
    });
    const first = runNoteVerify({ db: testDb(), artifactId: 'stale', runTaskFn });
    await vi.waitFor(() => expect(runTaskFn).toHaveBeenCalledTimes(1));
    await testDb().update(artifact).set({ version: 1 }).where(eq(artifact.id, 'stale'));
    release?.();
    await expect(first).rejects.toThrow('retry required');
    const [superseded] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'stale'));
    expect(superseded.state).toBe('retry_wait');
    expect(superseded.artifact_version).toBe(1);
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'stale', runTaskFn }),
    ).resolves.toMatchObject({ status: 'verified' });
    expect(runTaskFn).toHaveBeenCalledTimes(2);
    const [claim] = await testDb()
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'stale'));
    expect(claim.artifact_version).toBe(1);
    expect(claim.state).toBe('completed');
  });

  it('rejects an epoch change before provider start without calling AI', async () => {
    await seedArtifact('pre-start-epoch');
    const reservation = await reserveNoteVerification(testDb(), 'pre-start-epoch');
    if (reservation.kind !== 'claimed') throw new Error('expected claim');
    await testDb().update(artifact).set({ version: 1 }).where(eq(artifact.id, 'pre-start-epoch'));
    await expect(
      markNoteVerificationProviderStarted(testDb(), reservation.lease),
    ).resolves.toMatchObject({ kind: 'claim_changed' });
  });
});

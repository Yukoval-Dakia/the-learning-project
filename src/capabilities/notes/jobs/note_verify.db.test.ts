import { noteSectionsToBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import {
  markNoteVerificationProviderStarted,
  reserveNoteVerification,
  stageNoteVerificationResult,
} from '@/capabilities/notes/server/note-verification-claim';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { ai_task_runs, artifact, note_verification_claim } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
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
    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));
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

  it('fences concurrent delivery to exactly one paid call', async () => {
    await seedArtifact('concurrent');
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTaskFn = vi.fn(async () => {
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
    const runTaskFn = vi.fn(async () => {
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
    const runTaskFn = vi.fn(async () => {
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

  it('retries only when exact durable task run says failure', async () => {
    await seedArtifact('retry');
    let calls = 0;
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      calls += 1;
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
    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, 'retry'));
    expect(row.verification_status).toBe('queued');
    await testDb()
      .update(note_verification_claim)
      .set({ available_at: new Date(0) })
      .where(eq(note_verification_claim.artifact_id, 'retry'));
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'retry', runTaskFn }),
    ).resolves.toMatchObject({ status: 'verified' });
    expect(runTaskFn).toHaveBeenCalledTimes(2);
  });

  it('fails closed when provider start cannot be reconciled', async () => {
    await seedArtifact('ambiguous');
    const runTaskFn = vi.fn(async () => {
      throw new Error('connection lost after start');
    });
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'ambiguous', runTaskFn }),
    ).rejects.toThrow('connection lost');
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'ambiguous', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:ambiguous' });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
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
    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));
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
    await expect(recoverResultReadyNoteVerifications(testDb(), { boss })).resolves.toBe(0);
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
      await expect(recoverResultReadyNoteVerifications(testDb())).resolves.toBe(0);
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
    const runTaskFn = vi.fn(async () => {
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
    await expect(markNoteVerificationProviderStarted(testDb(), reservation.lease)).resolves.toBe(
      false,
    );
  });
});

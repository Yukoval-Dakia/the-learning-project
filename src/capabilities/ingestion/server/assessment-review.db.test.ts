import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Job } from 'pg-boss';
import postgres from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import * as schema from '@/db/schema';
import {
  ai_task_runs,
  job_events,
  knowledge,
  learning_session,
  material_fsrs_state,
  question,
  question_admission_verification,
  question_block,
  question_group_lifecycle,
} from '@/db/schema';
import { withinSessionAdvisoryLock } from '@/db/session-advisory-lock';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  type IngestionOperationJobData,
  buildIngestionOperationHandler,
} from '../jobs/ingestion_operation';
import {
  completeIngestionAssessmentReview,
  prepareIngestionAssessmentReview,
} from './assessment-review';
import { withinAssessmentReviewExecutionClient } from './assessment-review-client';
import {
  readIngestionOperation,
  reserveIngestionOperation,
  writeIngestionOperationEvent,
} from './operation-store';

beforeEach(resetDb);
const now = new Date('2026-10-10T00:00:00Z');

async function fixture(
  reference: string | null = '42',
  structuredAnswer?: string,
  originalPage = false,
) {
  const db = testDb();
  await db.insert(knowledge).values({
    id: 'review-kc',
    name: 'integer arithmetic',
    domain: 'math',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(learning_session).values({
    id: 'review-session',
    type: 'ingestion',
    status: 'imported',
    entrypoint: 'vision_paper',
    source_asset_ids: originalPage ? ['original-page-with-key'] : [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(question_block).values({
    id: 'review-block',
    ingestion_session_id: 'review-session',
    status: 'imported',
    imported_question_id: 'review-question',
    extracted_prompt_md: 'What is 6 times 7?',
    reference_md: reference,
    source_asset_ids: [],
    extraction_confidence: 1,
    created_at: now,
    updated_at: now,
    version: 1,
  });
  await db.insert(question).values({
    id: 'review-question',
    kind: 'calculation',
    judge_kind_override: 'exact',
    prompt_md: 'What is 6 times 7?',
    reference_md: reference,
    knowledge_ids: ['review-kc'],
    difficulty: 3,
    source: 'vision_paper',
    image_refs: originalPage ? ['original-page-with-key'] : [],
    ...(structuredAnswer
      ? {
          structured: {
            id: 'review-part',
            role: 'standalone',
            source: 'vlm_structure',
            prompt_text: 'What is 6 times 7?',
            answers: [structuredAnswer],
          },
        }
      : {}),
    metadata: { ingestion_session_id: 'review-session', question_block_id: 'review-block' },
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await publishQuestionGroupFromRow(db, {
    rootId: 'review-question',
    actorRef: 'test:material-save',
    now,
  });
  const prepared = await prepareIngestionAssessmentReview(db, {
    sessionId: 'review-session',
    blockId: 'review-block',
  });
  await reserveIngestionOperation(db, {
    operationId: prepared.operationId,
    sessionId: 'review-session',
    operationKind: 'assessment_review',
    inputHash: 'request',
    reviewBinding: prepared.binding,
    idempotencyKey: 'first',
  });
  return {
    db,
    ...prepared,
    input: { operationId: prepared.operationId, sessionId: 'review-session' },
  };
}

function solver(db: ReturnType<typeof testDb>, beforeReturn?: () => Promise<void>) {
  let calls = 0;
  const runTaskFn: TaskTextRunFn = async (kind) => {
    calls++;
    await beforeReturn?.();
    const output = {
      reference_solution: {
        final_answer: '42',
        answer_equivalents: [],
        expected_signals: ['Multiply 6 by 7'],
      },
      worked_solution_md: '6 times 7 is 42.',
      confidence: 1,
    };
    await db.insert(ai_task_runs).values({
      id: `review-run-${calls}`,
      task_kind: kind,
      provider: 'offline-invariant',
      model: 'no-provider-call',
      input_hash: 'offline-input',
      result_digest: canonicalHash(output),
      status: 'success',
      cost_usd: 0,
      cost_basis: 'estimated',
      cost_ref: 'offline-invariant',
      started_at: now,
      finished_at: now,
    });
    return { text: JSON.stringify(output), task_run_id: `review-run-${calls}`, cost_usd: 0 };
  };
  return { runTaskFn, calls: () => calls };
}

describe('ingestion assessment review settlement invariants (offline model boundary)', () => {
  it('deduplicates concurrent client keys by canonical identity and binds the aliases', async () => {
    const f = await fixture();
    const reservations = await Promise.all(
      ['second', 'third'].map((key) =>
        reserveIngestionOperation(f.db, {
          operationId: f.operationId,
          sessionId: 'review-session',
          operationKind: 'assessment_review',
          inputHash: 'request',
          reviewBinding: f.binding,
          idempotencyKey: key,
        }),
      ),
    );
    expect(
      reservations.every((r) => r.outcome === 'reused' && r.operationId === f.operationId),
    ).toBe(true);
    const next = { ...f.binding, admission_generation: f.binding.admission_generation + 1 };
    const { assessmentReviewOperationId } = await import('./assessment-review-evidence');
    expect(
      (
        await reserveIngestionOperation(f.db, {
          operationId: assessmentReviewOperationId(next),
          sessionId: 'review-session',
          operationKind: 'assessment_review',
          inputHash: 'changed',
          reviewBinding: next,
          idempotencyKey: 'second',
        })
      ).outcome,
    ).toBe('conflict');
    const accepted = await f.db
      .select()
      .from(job_events)
      .where(
        and(
          eq(job_events.business_id, f.operationId),
          eq(job_events.event_type, 'operation.accepted'),
        ),
      );
    expect(accepted).toHaveLength(1);
  });

  it('admits on strict agreement atomically and preserves container scope, session and absent FSRS', async () => {
    const f = await fixture();
    const model = solver(f.db);
    await completeIngestionAssessmentReview(f.db, f.input, model);
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'admitted',
      assessment: { availability: 'container_only', admission: { state: 'admitted' } },
      verification: {
        task_runs: [{ provider: 'offline-invariant', model: 'no-provider-call', cost_usd: 0 }],
      },
    });
    expect(await f.db.select().from(question_admission_verification)).toHaveLength(1);
    expect(await f.db.select().from(material_fsrs_state)).toHaveLength(0);
    expect((await f.db.select().from(learning_session))[0].status).toBe('imported');
    await completeIngestionAssessmentReview(f.db, f.input, model);
    expect(model.calls()).toBe(1);
  });

  it('verifies the printed structured key with a null or conflicting row reference', async () => {
    const f = await fixture(null, '42');
    const model = solver(f.db);
    await completeIngestionAssessmentReview(f.db, f.input, model);
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'admitted',
    });
    expect((await f.db.select().from(question))[0].reference_md).toBeNull();
    expect(model.calls()).toBe(1);
  });

  it('routes the real operation worker consumer without re-entering import', async () => {
    const f = await fixture(null);
    const job = {
      id: 'review-job',
      name: 'ingestion_operation',
      expireInSeconds: 60,
      heartbeatSeconds: 0,
      retryCount: 0,
      signal: new AbortController().signal,
      data: {
        ...f.input,
        request: { kind: 'assessment_review', input: { block_id: 'review-block' } },
      },
    } satisfies Job<IngestionOperationJobData>;
    await buildIngestionOperationHandler(f.db)([job]);
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'withheld',
      reason: 'missing_reference',
    });
    expect((await f.db.select().from(question))[0].reference_md).toBeNull();
    expect((await f.db.select().from(learning_session))[0].status).toBe('imported');
  });

  it('excludes original answer-page photos from a complete frozen structured prompt', async () => {
    const f = await fixture(null, '42', true);
    const model = solver(f.db);
    const inputs: unknown[] = [];
    await completeIngestionAssessmentReview(f.db, f.input, {
      runTaskFn: async (kind, input, ctx) => {
        inputs.push(input);
        return model.runTaskFn(kind, input, ctx);
      },
      loadImages: async (assets) => {
        expect(assets).toEqual([]);
        return [];
      },
    });
    expect(JSON.stringify(inputs)).not.toContain('original-page-with-key');
    expect(inputs[0]).toMatchObject({
      prompt_image_refs: [],
      figures_hint: [],
      existing_answers_hint: null,
      existing_analysis_hint: null,
    });
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'admitted',
    });
    expect(model.calls()).toBe(1);
  });

  it('withholds a legacy page-backed prompt rather than silently dropping necessary media', async () => {
    const f = await fixture('42', undefined, true);
    const model = solver(f.db);
    await completeIngestionAssessmentReview(f.db, f.input, model);
    expect(model.calls()).toBe(0);
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'withheld',
      reason: 'unsupported_legacy_image_contract',
    });
  });

  it('never calls the model for a started stage without its parsed result', async () => {
    const f = await fixture();
    const model = solver(f.db);
    await writeIngestionOperationEvent(f.db, {
      operationId: f.operationId,
      eventType: 'operation.review_started',
    });
    await completeIngestionAssessmentReview(f.db, f.input, model);
    expect(model.calls()).toBe(0);
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'withheld',
      reason: 'unknown_result',
    });
  });

  it('retains an uncertain provider call without paying on redelivery', async () => {
    const f = await fixture();
    let calls = 0;
    const runTaskFn: TaskTextRunFn = async () => {
      calls++;
      throw new Error('unknown provider outcome');
    };
    await completeIngestionAssessmentReview(f.db, f.input, { runTaskFn });
    await completeIngestionAssessmentReview(f.db, f.input, { runTaskFn });
    expect(calls).toBe(1);
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'withheld',
      reason: 'unknown_result',
    });
  });

  it('never pays a duplicate delivery while the first call is still in flight', async () => {
    const f = await fixture();
    let enter: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = solver(f.db, async () => {
      enter();
      await pending;
    });
    const first = completeIngestionAssessmentReview(f.db, f.input, model);
    await entered;
    const duplicate = completeIngestionAssessmentReview(f.db, f.input, model);
    release();
    await Promise.all([first, duplicate]);
    expect(model.calls()).toBe(1);
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'admitted',
      reason: 'verification_passed',
    });
    expect((await f.db.select().from(question_group_lifecycle))[0].scoring_admission_state).toBe(
      'admitted',
    );
  });

  it('a busy duplicate writes no terminal outcome and leaves the first invocation able to admit', async () => {
    const f = await fixture();
    let enter: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = solver(f.db, async () => {
      enter();
      await pending;
    });
    const first = completeIngestionAssessmentReview(f.db, f.input, model);
    await entered;
    try {
      await expect(
        completeIngestionAssessmentReview(f.db, f.input, { ...model, lockWaitMs: 25 }),
      ).rejects.toMatchObject({ code: 'assessment_review_busy' });
      expect((await readIngestionOperation(f.db, f.operationId))?.status).toBe('running');
      expect(model.calls()).toBe(1);
    } finally {
      release();
    }
    await first;
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'admitted',
    });
  });

  it('keeps runner lifecycle transactions on another backend from the pinned domain owner', async () => {
    const f = await fixture();
    const model = solver(f.db);
    await completeIngestionAssessmentReview(f.db, f.input, {
      runTaskFn: async (kind, input, ctx) => {
        expect(Reflect.get(ctx ?? {}, 'db')).toBe(f.db);
        const [owner] = await f.db.execute<{ pid: number }>(sql`
          SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2
            AND classid = (hashtext('ingestion-assessment-execution')::bigint & 4294967295)::oid
            AND objid = (hashtext(${f.operationId})::bigint & 4294967295)::oid
        `);
        await f.db.transaction(async (tx) => {
          const [runner] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
          expect(runner.pid).not.toBe(owner.pid);
        });
        await ctx?.beforeProviderQuery?.({
          taskRunId: 'review-run-1',
          provider: 'openai',
          model: 'no-provider-call',
        });
        return model.runTaskFn(kind, input, ctx);
      },
    });
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'admitted',
    });
  });

  it.each(['42', '41'])(
    'refuses old output %s after isolated backend loss without disturbing a successor client lock or transaction',
    async (answer) => {
      const f = await fixture();
      const url = process.env.TEST_DATABASE_URL;
      if (!url) throw new Error('Missing test database URL');
      const client = postgres(url, { max: 1 });
      const ownerDb = drizzle(client, { schema });
      const [originalPool] = await ownerDb.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let providerCalls = 0;
      const first = completeIngestionAssessmentReview(ownerDb, f.input, {
        runTaskFn: async (_kind, _input, ctx) => {
          await ctx?.beforeProviderQuery?.({
            taskRunId: 'lost-run',
            provider: 'openai',
            model: 'no-provider-call',
          });
          providerCalls++;
          enter();
          await pending;
          return {
            text: JSON.stringify({
              reference_solution: {
                final_answer: answer,
                answer_equivalents: [],
                expected_signals: ['multiply'],
              },
              worked_solution_md: 'offline',
              confidence: 1,
            }),
            task_run_id: 'lost-run',
          };
        },
      }).then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      await entered;
      const [oldOwner] = await f.db.execute<{ pid: number }>(sql`
      SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2
        AND classid = (hashtext('ingestion-assessment-execution')::bigint & 4294967295)::oid
        AND objid = (hashtext(${f.operationId})::bigint & 4294967295)::oid
    `);
      expect(oldOwner.pid).not.toBe(originalPool.pid);
      await f.db.execute(sql`SELECT pg_terminate_backend(${oldOwner.pid})`);
      try {
        await withinAssessmentReviewExecutionClient(client, (successorClient) =>
          withinSessionAdvisoryLock(
            drizzle(successorClient, { schema }),
            {
              namespace: 'ingestion-assessment-execution',
              key: f.operationId,
              busy: () => new Error('successor lock unavailable'),
            },
            new Date(Date.now() + 2000),
            async (successorDb) => {
              await successorDb.transaction(async (tx) => {
                const [successor] = await tx.execute<{ pid: number }>(
                  sql`SELECT pg_backend_pid() AS pid`,
                );
                expect(successor.pid).not.toBe(oldOwner.pid);
                await tx.insert(job_events).values({
                  business_table: 'yuk1404-successor',
                  business_id: f.operationId,
                  event_type: 'fixture.control',
                  payload: {},
                });
                release();
                const old = await Promise.race([
                  first,
                  new Promise<never>((_resolve, reject) =>
                    setTimeout(
                      () => reject(new Error('old cleanup disturbed successor progress')),
                      1000,
                    ),
                  ),
                ]);
                expect(old.error).not.toBeNull();
                const [pooled] = await ownerDb.execute<{ pid: number }>(
                  sql`SELECT pg_backend_pid() AS pid`,
                );
                expect(pooled.pid).toBe(originalPool.pid);
                expect(pooled.pid).not.toBe(successor.pid);
                const [held] = await tx.execute<{ owned: boolean }>(sql`
            SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
              AND pid = pg_backend_pid() AND granted AND objsubid = 2
              AND classid = (hashtext('ingestion-assessment-execution')::bigint & 4294967295)::oid
              AND objid = (hashtext(${f.operationId})::bigint & 4294967295)::oid) AS owned
          `);
                expect(held.owned).toBe(true);
                expect(
                  await tx
                    .select()
                    .from(job_events)
                    .where(eq(job_events.business_table, 'yuk1404-successor')),
                ).toHaveLength(1);
                throw new Error('rollback successor control');
              });
            },
          ),
        ).catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'rollback successor control')
            throw error;
        });
        expect(
          await f.db
            .select()
            .from(job_events)
            .where(eq(job_events.business_table, 'yuk1404-successor')),
        ).toHaveLength(0);
        expect(providerCalls).toBe(1);
        expect(
          await f.db
            .select()
            .from(job_events)
            .where(eq(job_events.event_type, 'operation.review_result')),
        ).toHaveLength(0);
        expect(await f.db.select().from(question_admission_verification)).toHaveLength(0);
        await completeIngestionAssessmentReview(f.db, f.input, {
          runTaskFn: async () => {
            throw new Error('abandoned stage must not pay again');
          },
        });
        expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
          status: 'withheld',
          reason: 'unknown_result',
        });
      } finally {
        release();
        await first;
        await client.end();
      }
    },
  );

  it('withholds stale paid output after a block edit', async () => {
    const f = await fixture();
    const model = solver(f.db, async () => {
      await f.db
        .update(question_block)
        .set({ version: 2 })
        .where(eq(question_block.id, 'review-block'));
    });
    await completeIngestionAssessmentReview(f.db, f.input, model);
    expect(model.calls()).toBe(1);
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'superseded',
      reason: 'binding_changed',
    });
    expect((await f.db.select().from(question_group_lifecycle))[0].scoring_admission_state).toBe(
      'withheld',
    );
    expect(await f.db.select().from(question_admission_verification)).toHaveLength(0);
  });

  it('rolls admission back on receipt failure and reuses the persisted result on a local retry', async () => {
    const f = await fixture();
    const model = solver(f.db);
    await f.db.execute(sql`CREATE FUNCTION yuk1404_reject_done() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = 'operation.completed' AND starts_with(NEW.business_id, 'ingreview_v1_') THEN
      RAISE EXCEPTION 'injected local receipt failure'; END IF; RETURN NEW; END; $$`);
    await f.db.execute(
      sql`CREATE TRIGGER yuk1404_reject_done BEFORE INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION yuk1404_reject_done()`,
    );
    try {
      await expect(completeIngestionAssessmentReview(f.db, f.input, model)).rejects.toThrow();
      expect((await f.db.select().from(question_group_lifecycle))[0].scoring_admission_state).toBe(
        'withheld',
      );
      expect(await f.db.select().from(question_admission_verification)).toHaveLength(0);
    } finally {
      await f.db.execute(sql`DROP TRIGGER yuk1404_reject_done ON job_events`);
      await f.db.execute(sql`DROP FUNCTION yuk1404_reject_done()`);
    }
    expect(
      await f.db
        .select()
        .from(job_events)
        .where(eq(job_events.event_type, 'operation.review_result')),
    ).toHaveLength(1);
    await completeIngestionAssessmentReview(f.db, f.input, model);
    expect(model.calls()).toBe(1);
    expect((await readIngestionOperation(f.db, f.operationId))?.result).toMatchObject({
      status: 'admitted',
    });
  });
});

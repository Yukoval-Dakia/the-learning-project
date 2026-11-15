import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { db } from '@/db/client';
import { paid_effect, question } from '@/db/schema';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { EMBED_DIMS, type embedMany } from '@/server/ai/embed';
import { _resetBossForTests, createBoss } from '@/server/boss/client';
import { resetDb } from '../../../../../tests/helpers/db';
import { enqueuePublicationEmbed } from '../server/publication-embed-enqueue';
import { questionVectorInvalidReason, runQuestionEmbedding } from './embed_backfill';
import {
  PUBLICATION_EMBED_JOB,
  type PublicationEmbedJobData,
  runPublicationEmbed,
} from './publication_embed';

let boss: ReturnType<typeof createBoss>;
beforeAll(async () => {
  _resetBossForTests();
  boss = createBoss();
  await boss.start();
  await boss.createQueue(PUBLICATION_EMBED_JOB);
});
beforeEach(async () => {
  await resetDb();
  await boss.deleteAllJobs(PUBLICATION_EMBED_JOB);
});
afterAll(async () => {
  await boss.deleteAllJobs(PUBLICATION_EMBED_JOB);
  await boss.stop({ graceful: false, timeout: 1_000 });
  _resetBossForTests();
});

// @invariant concurrency: same-revision queue replay and nightly reconciliation share one paid send.
// @fails-if a saved receipt is repaid after application failure, or an unknown send is retried.
it.each(['application', 'unknown'] as const)(
  'recovers %s failure without a second paid send',
  async (failure) => {
    const id = `publication-${failure}`;
    const now = new Date();
    await db.insert(question).values({
      id,
      kind: 'choice',
      prompt_md: 'Which is two?',
      reference_md: 'B',
      choices_md: ['1', '2'],
      source: 'web_sourced',
      draft_status: 'active',
      created_at: now,
      updated_at: now,
    });
    const published = await publishQuestionGroupFromRow(db, {
      rootId: id,
      actorRef: 'test:publication',
      now,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'official',
          model_slice: null,
          verification: { structural_check_passed: true, independent_verification: null },
        },
      },
    });
    if (published.status !== 'published') throw new Error('question did not publish');
    const delivery = {
      subscriberId: 'practice.question-publication-embed',
      subscriberVersion: 1,
      deliverySeq: '1',
      sourceEventId: published.event_id,
    };
    expect((await enqueuePublicationEmbed(db, delivery)).status).toBe('succeeded');
    expect((await enqueuePublicationEmbed(db, delivery)).status).toBe('skipped');
    const [job] = await boss.fetch<PublicationEmbedJobData>(PUBLICATION_EMBED_JOB);
    if (!job) throw new Error('publication job missing');
    let sends = 0;
    const provider: typeof embedMany = async (_texts, attempt) => {
      await attempt?.beforeSend?.();
      sends += 1;
      if (failure === 'unknown') throw new Error('response lost after send');
      return [Array(EMBED_DIMS).fill(0.25)];
    };
    const attempt = {
      db,
      caller: 'worker' as const,
      deadlineAt: new Date(Date.now() + 20_000),
      operationAnchor: job.id,
    };
    if (failure === 'application') {
      await db.execute(sql`create function fail_publication_embed() returns trigger language plpgsql as $$
      begin if new.embedding is not null then raise exception 'application unavailable'; end if; return new; end $$`);
      await db.execute(sql`create trigger fail_publication_embed before update on question
      for each row execute function fail_publication_embed()`);
    }
    try {
      await expect(runPublicationEmbed(db, job.data, attempt, provider)).rejects.toThrow();
    } finally {
      if (failure === 'application') {
        await db.execute(sql`drop trigger fail_publication_embed on question`);
        await db.execute(sql`drop function fail_publication_embed()`);
      }
    }
    const [effect] = await db.select().from(paid_effect).where(eq(paid_effect.entity_id, id));
    expect(effect.state).toBe(failure === 'application' ? 'receipt_ready' : 'unknown');
    if (failure === 'application') {
      expect(await runPublicationEmbed(db, job.data, attempt, provider)).toBe('embedded');
      const [row] = await db.select().from(question).where(eq(question.id, id));
      expect(
        questionVectorInvalidReason({ ...row, dimension: row.embedding?.length ?? null }),
      ).toBeNull();
    } else {
      await expect(runPublicationEmbed(db, job.data, attempt, provider)).rejects.toThrow(
        'reconciliation',
      );
    }
    expect(await runQuestionEmbedding(db, id, attempt, provider)).toBe(
      failure === 'application' ? 'skipped' : 'held',
    );
    expect(sends).toBe(1);
    await boss.complete(PUBLICATION_EMBED_JOB, job.id);
    // Completion retains the job id; replay must not rely on immediate deletion.
    expect((await enqueuePublicationEmbed(db, delivery)).status).toBe('skipped');
  },
);

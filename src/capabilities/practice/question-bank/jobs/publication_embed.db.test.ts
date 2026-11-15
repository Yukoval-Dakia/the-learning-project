import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { computePaidEffectIdentity } from '@/core/paid-work/protocol/paid-effect-protocol';
import {
  readPaidEffectAuthorizations,
  voidPaidEffectWithSuccessor,
} from '@/core/paid-work/server/paid-effect-store';
import { db } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { paid_effect, question } from '@/db/schema';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { EMBED_DIMS, EmbeddingRequestNotSentError, type embedMany } from '@/server/ai/embed';
import { _resetBossForTests, createBoss } from '@/server/boss/client';
import { resetDb } from '../../../../../tests/helpers/db';
import { enqueuePublicationEmbed } from '../server/publication-embed-enqueue';
import {
  questionVectorInvalidReason,
  runEmbedBackfill,
  runQuestionEmbedding,
} from './embed_backfill';
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
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await boss.deleteAllJobs(PUBLICATION_EMBED_JOB);
  await boss.stop({ graceful: false, timeout: 1_000 });
  _resetBossForTests();
});

const ADMITTED = {
  state: 'admitted' as const,
  evidence: {
    marking_provenance: 'official' as const,
    model_slice: null,
    verification: { structural_check_passed: true, independent_verification: null },
  },
};

async function publish(id: string): Promise<PublicationEmbedJobData> {
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
    admission: ADMITTED,
  });
  if (published.status !== 'published') throw new Error('question did not publish');
  return { group_id: id, revision_id: published.revision_id, source_event_id: published.event_id };
}

// @invariant concurrency: same-revision queue replay and nightly reconciliation share one paid send.
// @fails-if a saved receipt is repaid after application failure, or an unknown send is retried.
it.each(['application', 'unknown'] as const)(
  'recovers %s failure without a second paid send',
  async (failure) => {
    const id = `publication-${failure}`;
    const data = await publish(id);
    const delivery = {
      subscriberId: 'practice.question-publication-embed',
      subscriberVersion: 1,
      deliverySeq: '1',
      sourceEventId: data.source_event_id,
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

// @invariant security: a proven pre-wire stop neither buys a vector nor blocks a later authorized current source.
// @fails-if missing credentials, changed content, revoked purpose or an aborted pre-wire request creates an irreversible unknown hold.
it.each(['credentials', 'source', 'purpose', 'abort'] as const)(
  'preserves truthful no-send recovery for %s',
  async (stop) => {
    const id = `prewire-${stop}`;
    let data = await publish(id);
    const attempt = {
      db,
      caller: 'worker' as const,
      deadlineAt: new Date(Date.now() + 20_000),
      operationAnchor: id,
    };
    let sends = 0;
    const provider: typeof embedMany = async (_texts, options) => {
      await options?.beforeSend?.();
      if (stop === 'abort') throw new EmbeddingRequestNotSentError('send_not_authorized');
      sends += 1;
      return [Array(EMBED_DIMS).fill(0.25)];
    };
    if (stop === 'credentials') {
      vi.stubEnv('DASHSCOPE_API_KEY', '');
      await expect(runPublicationEmbed(db, data, attempt)).rejects.toThrow('credentials_missing');
      vi.unstubAllEnvs();
      const rows = await db.select().from(paid_effect).where(eq(paid_effect.entity_id, id));
      expect(rows.map((row) => row.state)).toEqual(['pending']);
    } else if (stop === 'abort') {
      await expect(runPublicationEmbed(db, data, attempt, provider)).rejects.toThrow(
        'send_not_authorized',
      );
    } else {
      // Inject the real edit/revocation at the paid claim commit, before the final wire fence.
      await db.execute(sql`create function change_embed_source() returns trigger language plpgsql as $$
      begin
        if new.family = 'embed_backfill' and old.state = 'pending' and new.state = 'sending' then
          if new.entity_id = 'prewire-source' then
            update question set prompt_md = 'Changed before send', version = version + 1 where id = new.entity_id;
          else
            update question set metadata = coalesce(metadata, '{}'::jsonb) || '{"derivation_policy":"answer_only"}'::jsonb where id = new.entity_id;
          end if;
        end if;
        return new;
      end $$`);
      await db.execute(
        sql`create trigger change_embed_source after update on paid_effect for each row execute function change_embed_source()`,
      );
      try {
        expect(await runPublicationEmbed(db, data, attempt, provider)).toBe('skipped');
      } finally {
        await db.execute(sql`drop trigger change_embed_source on paid_effect`);
        await db.execute(sql`drop function change_embed_source()`);
      }
    }
    expect(sends).toBe(0);
    if (stop !== 'credentials') {
      const [control] = await db.select().from(paid_effect).where(eq(paid_effect.entity_id, id));
      expect(control.state).toBe('applied');
      expect(control.result_json).toEqual({
        status: 'not_sent',
        reason: 'provider_send_not_authorized',
      });
    }
    if (stop === 'purpose') {
      await db
        .update(question)
        .set({ metadata: { derivation_policy: 'allow' } })
        .where(eq(question.id, id));
    } else if (stop === 'source') {
      const current = await publishQuestionGroupFromRow(db, {
        rootId: id,
        actorRef: 'test:republish',
        now: new Date(),
        admission: ADMITTED,
      });
      if (current.status !== 'published') throw new Error('changed source did not republish');
      data = { group_id: id, revision_id: current.revision_id, source_event_id: current.event_id };
    }
    const restored: typeof embedMany = async (_texts, options) => {
      await options?.beforeSend?.();
      sends += 1;
      return [Array(EMBED_DIMS).fill(0.5)];
    };
    expect(await runPublicationEmbed(db, data, attempt, restored)).toBe('embedded');
    expect(sends).toBe(1);
    const effects = await db.select().from(paid_effect).where(eq(paid_effect.entity_id, id));
    expect(effects.every((effect) => effect.state === 'applied')).toBe(true);
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(
      questionVectorInvalidReason({ ...row, dimension: row.embedding?.length ?? null }),
    ).toBeNull();
  },
);

// @invariant concurrency: an expired send stays held until an exact bound operator successor continues; old receipts and fences remain immutable.
// @fails-if drifted input or another delivery buys a vector, accepted receipts are repaid, or the retired writer applies a late response.
it.each(['continuation', 'not_sent', 'source_changed', 'drifted', 'legacy_wrapper'] as const)(
  'continues only the authorized embedding recovery: %s',
  async (recovery) => {
    const id = 'abandoned-embedding';
    const data = await publish(id);
    const attempt = {
      db,
      caller: 'worker' as const,
      deadlineAt: new Date(Date.now() + 20_000),
      operationAnchor: id,
    };
    let entered!: () => void;
    let release!: (vectors: number[][]) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const response = new Promise<number[][]>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const provider: typeof embedMany = async (_texts, options) => {
      await options?.beforeSend?.();
      sends += 1;
      entered();
      return response;
    };
    const running = runPublicationEmbed(db, data, attempt, provider).then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    await db
      .update(paid_effect)
      .set({ send_lease_expires_at: new Date(0) })
      .where(eq(paid_effect.entity_id, id));
    await expect(runPublicationEmbed(db, data, attempt, provider)).rejects.toThrow(
      'reconciliation',
    );
    const [expired] = await db.select().from(paid_effect).where(eq(paid_effect.entity_id, id));
    expect(expired.state).toBe('unknown');
    expect(expired.unresolved_reason).toBe('send_lease_expired');
    await expect(runEmbedBackfill(db, 1, attempt, provider)).rejects.toThrow(
      'held paid obligations',
    );
    expect(sends).toBe(1);
    const identity = computePaidEffectIdentity({
      family: expired.family,
      entityId: id,
      entityRevision: expired.entity_revision,
      unit: expired.unit,
      input: expired.input_json,
    });
    const successorInput = {
      family: expired.family,
      entityId: id,
      entityRevision: expired.entity_revision,
      unit: expired.unit,
      input:
        recovery === 'legacy_wrapper'
          ? { previous_input: expired.input_json, recovery: 'explicit' }
          : {
              ...(expired.input_json as object),
              recovery: 'explicit',
              ...(recovery === 'drifted' ? { model: 'unapproved-model' } : {}),
            },
    };
    const successorIdentity = computePaidEffectIdentity(successorInput);
    const deliveryId = randomUUID();
    // The generic operator API and pg-boss share one transaction, just as the
    // production admission recovery does; this is the delivery the worker sees.
    await db.transaction(async (tx) => {
      const queued = await boss.send(PUBLICATION_EMBED_JOB, data, {
        id: deliveryId,
        db: fromPgBossDrizzleTx(tx),
      });
      if (!queued) throw new Error('recovery job was not inserted');
      await voidPaidEffectWithSuccessor(tx, identity, {
        expectedFence: expired.fence,
        authorization: {
          authorizationId: 'embedding-expiry-recovery',
          reason: 'explicit reconciliation of the abandoned send',
          operator: 'test:operator',
          basis: 'test:approved-recovery',
          successorInput,
          successorDelivery: { backend: 'pg-boss', deliveryId },
        },
      });
    });
    const oldWhere = and(
      eq(paid_effect.entity_id, id),
      eq(paid_effect.input_digest, identity.inputDigest),
    );
    const successorWhere = and(
      eq(paid_effect.entity_id, id),
      eq(paid_effect.input_digest, successorIdentity.inputDigest),
    );
    const [retired] = await db.select().from(paid_effect).where(oldWhere);
    release([Array(EMBED_DIMS).fill(0.5)]);
    expect(await running).toBeInstanceOf(Error);
    const [afterLate] = await db.select().from(paid_effect).where(oldWhere);
    expect(afterLate).toEqual(retired);
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(row.embedding).toBeNull();
    const [bound] = await boss.fetch<PublicationEmbedJobData>(PUBLICATION_EMBED_JOB);
    if (!bound) throw new Error('bound recovery delivery missing');
    expect(bound.id).toBe(deliveryId);
    const boundAttempt = { ...attempt, operationAnchor: bound.id };
    const recoveredProvider: typeof embedMany = async (_texts, options) => {
      await options?.beforeSend?.();
      sends += 1;
      return [Array(EMBED_DIMS).fill(0.75)];
    };
    if (recovery === 'drifted' || recovery === 'legacy_wrapper') {
      await expect(
        runPublicationEmbed(db, bound.data, boundAttempt, recoveredProvider),
      ).rejects.toThrow('reconciliation');
      const [held] = await db.select().from(paid_effect).where(successorWhere);
      expect(held.state).toBe('pending');
      expect(sends).toBe(1);
      return;
    }
    await boss.send(PUBLICATION_EMBED_JOB, data, { id: randomUUID() });
    const [other] = await boss.fetch<PublicationEmbedJobData>(PUBLICATION_EMBED_JOB);
    if (!other) throw new Error('other recovery delivery missing');
    const otherAttempt = { ...attempt, operationAnchor: other.id };
    await expect(
      runPublicationEmbed(db, other.data, otherAttempt, recoveredProvider),
    ).rejects.toThrow('reconciliation');
    expect(sends).toBe(1);
    if (recovery === 'not_sent') {
      const refused: typeof embedMany = async (_texts, options) => {
        await options?.beforeSend?.();
        throw new EmbeddingRequestNotSentError('send_not_authorized');
      };
      await expect(runPublicationEmbed(db, bound.data, boundAttempt, refused)).rejects.toThrow(
        'send_not_authorized',
      );
      const [notSent] = await db.select().from(paid_effect).where(successorWhere);
      expect(notSent.state).toBe('applied');
      expect(notSent.result_json).toMatchObject({ status: 'not_sent' });
      expect(await runPublicationEmbed(db, other.data, otherAttempt, recoveredProvider)).toBe(
        'embedded',
      );
      const [retry] = await db
        .select()
        .from(paid_effect)
        .where(
          and(
            eq(paid_effect.entity_id, id),
            sql`${paid_effect.input_json}->>'not_sent_attempt' = '1'`,
          ),
        );
      expect(retry.state).toBe('applied');
      expect(retry.input_json).toEqual({
        ...(successorInput.input as object),
        not_sent_attempt: 1,
      });
      const [afterRetry] = await db.select().from(paid_effect).where(oldWhere);
      expect(afterRetry).toEqual(retired);
      expect(sends).toBe(2);
      return;
    }
    if (recovery === 'source_changed') {
      await db.execute(sql`create function change_recovered_source() returns trigger language plpgsql as $$
        begin
          if old.state = 'sending' and new.state = 'receipt_ready' and new.entity_id = 'abandoned-embedding' then
            update question set prompt_md = 'Changed after authorized send', version = version + 1 where id = new.entity_id;
          end if;
          return new;
        end $$`);
      await db.execute(sql`create trigger change_recovered_source after update on paid_effect
        for each row execute function change_recovered_source()`);
      try {
        expect(await runPublicationEmbed(db, bound.data, boundAttempt, recoveredProvider)).toBe(
          'skipped',
        );
      } finally {
        await db.execute(sql`drop trigger change_recovered_source on paid_effect`);
        await db.execute(sql`drop function change_recovered_source()`);
      }
      const [changed] = await db.select().from(question).where(eq(question.id, id));
      expect(changed.embedding).toBeNull();
      expect(sends).toBe(2);
      const current = await publishQuestionGroupFromRow(db, {
        rootId: id,
        actorRef: 'test:recovery-republish',
        now: new Date(),
        admission: ADMITTED,
      });
      if (current.status !== 'published')
        throw new Error('changed recovery source did not publish');
      await enqueuePublicationEmbed(db, {
        subscriberId: 'practice.question-publication-embed',
        subscriberVersion: 1,
        deliverySeq: '2',
        sourceEventId: current.event_id,
      });
      const [next] = await boss.fetch<PublicationEmbedJobData>(PUBLICATION_EMBED_JOB);
      if (!next) throw new Error('current revision delivery missing');
      expect(
        await runPublicationEmbed(
          db,
          next.data,
          { ...attempt, operationAnchor: next.id },
          recoveredProvider,
        ),
      ).toBe('embedded');
      expect(sends).toBe(3);
      const [afterCurrent] = await db.select().from(paid_effect).where(oldWhere);
      expect(afterCurrent).toEqual(retired);
      return;
    }
    await db.execute(sql`create function fail_recovered_embed() returns trigger language plpgsql as $$
      begin if new.embedding is not null then raise exception 'application unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger fail_recovered_embed before update on question
      for each row execute function fail_recovered_embed()`);
    try {
      await expect(
        runPublicationEmbed(db, bound.data, boundAttempt, recoveredProvider),
      ).rejects.toMatchObject({
        cause: { code: 'P0001', message: 'application unavailable' },
      });
      const [saved] = await db.select().from(paid_effect).where(successorWhere);
      expect(saved.state).toBe('receipt_ready');
      expect(saved.input_json).toEqual(successorInput.input);
    } finally {
      await db.execute(sql`drop trigger fail_recovered_embed on question`);
      await db.execute(sql`drop function fail_recovered_embed()`);
    }
    expect(await runPublicationEmbed(db, other.data, otherAttempt, recoveredProvider)).toBe(
      'embedded',
    );
    expect(await runPublicationEmbed(db, bound.data, boundAttempt, recoveredProvider)).toBe(
      'skipped',
    );
    const [embedded] = await db.select().from(question).where(eq(question.id, id));
    expect(embedded.embedding?.[0]).toBe(0.75);
    expect(
      questionVectorInvalidReason({ ...embedded, dimension: embedded.embedding?.length ?? null }),
    ).toBeNull();
    const [applied] = await db.select().from(paid_effect).where(successorWhere);
    expect(applied.state).toBe('applied');
    await db.update(question).set({ embedding: null }).where(eq(question.id, id));
    expect(await runPublicationEmbed(db, other.data, otherAttempt, recoveredProvider)).toBe(
      'embedded',
    );
    const [replayed] = await db.select().from(paid_effect).where(successorWhere);
    expect(replayed).toEqual(applied);
    const [authorization] = await readPaidEffectAuthorizations(db, {
      family: expired.family,
      entityId: id,
    });
    expect(authorization.consumed_delivery_id).toBe(bound.id);
    const [afterRecovery] = await db.select().from(paid_effect).where(oldWhere);
    expect(afterRecovery).toEqual(retired);
    expect(sends).toBe(2);
  },
);

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { knowledge, learning_item, question } from '@/db/schema';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { applyQuestionBlockTransition } from '@/kernel/records/question-block-transitions';
import { streamLocalDate } from '@/kernel/stream-date';
import { loadEventSubscriptionRegistry } from '@/server/events/subscriptions/registry';
import { bootstrapSubscription } from '@/server/events/subscriptions/runtime';
import { resetDb } from '../../../../../tests/helpers/db';
import { schedulingManifestPart } from '../manifest-part';
import { getPracticeStream } from './stream-operations';
import { composeNightly } from './stream-store';

const DATE = '2026-08-10';
const clients: Array<ReturnType<typeof postgres>> = [];

function createTenConnectionDb(): { db: Db; client: ReturnType<typeof postgres> } {
  return createConnectionDb(10);
}

function createConnectionDb(max: number): { db: Db; client: ReturnType<typeof postgres> } {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new TypeError('TEST_DATABASE_URL is required');
  const client = postgres(url, {
    max,
    connection: { statement_timeout: 750 },
  });
  clients.push(client);
  return { db: drizzle(client, { schema }), client };
}

async function seedSamplableQuestion(db: Db): Promise<string> {
  const now = new Date();
  const knowledgeId = createId();
  const questionId = createId();
  await db.insert(knowledge).values({
    id: knowledgeId,
    name: '并发事务边界',
    domain: 'computer-science',
    created_at: now,
    updated_at: now,
  });
  await db.insert(learning_item).values({
    id: createId(),
    source: 'learning_intent',
    title: '并发事务边界',
    knowledge_ids: [knowledgeId],
    status: 'pending',
    created_at: now,
    updated_at: now,
  });
  await db.insert(question).values({
    id: questionId,
    kind: 'choice',
    prompt_md: '哪一个事务边界不会让连接池自我饥饿？',
    reference_md: 'B',
    choices_md: [
      'provider lifecycle 嵌套在 compose lock transaction 内',
      'provider lifecycle 在 compose lock transaction 之外',
    ],
    knowledge_ids: [knowledgeId],
    source: 'manual',
    draft_status: 'active',
    created_at: now,
    updated_at: now,
  });
  // Compose candidates must be published + admitted + automatically servable —
  // pin an explicit deterministic option-set contract (owner: no
  // reference_md key extraction / normalizer guess-key path).
  const options = [
    {
      option_id: `opt_${questionId}_a`,
      label: 'A',
      text: 'provider lifecycle 嵌套在 compose lock transaction 内',
    },
    {
      option_id: `opt_${questionId}_b`,
      label: 'B',
      text: 'provider lifecycle 在 compose lock transaction 之外',
    },
  ];
  const contract = {
    structure: {
      group_id: questionId,
      materials: [],
      parts: [
        {
          part_id: 'p1',
          prompt_md: '哪一个事务边界不会让连接池自我饥饿？',
          material_ids: [],
        },
      ],
    },
    response_spec: {
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'single_choice' as const, options }],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'option_set_key' as const,
            accepted_option_ids: [`opt_${questionId}_b`],
          },
          points: 2,
        },
      ],
      aggregation: { kind: 'sum' as const },
      blank_scores_zero: true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic' as const, comparator: 'exact_option_set' as const },
        },
      ],
      escalation: {
        on_unadmitted_model: 'withhold' as const,
        on_low_confidence: 'human_review' as const,
      },
    },
  };
  const published = await publishQuestionGroup(db, {
    group_id: questionId,
    contract: { ...contract, integrity_digest: contractIntegrityDigest(contract) },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    actorRef: 'test:stream-provider-lock',
    now,
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
  });
  if (published.status !== 'published') throw new Error(published.status);
  return questionId;
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.end({ timeout: 1 })));
});

describe('Practice stream provider transaction boundary', () => {
  it('keeps a top-level provider transaction outside ten concurrent compose lock transactions', async () => {
    // Given a max=10 pool, one samplable candidate, and a loader that needs another transaction.
    const { db } = createTenConnectionDb();
    const questionId = await seedSamplableQuestion(db);
    const loadMemoryPrior = vi.fn(() =>
      db.transaction(async (tx) => {
        await tx.select({ id: question.id }).from(question).limit(1);
        return ['事务边界必须隔离'];
      }),
    );
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        candidates: [{ refId: questionId, weight: 1, role: 'new_check', reason: '事务边界清晰' }],
      }),
    }));

    // When ten same-date compose invocations contend for the paid-work single-flight boundary.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        composeNightly(db, DATE, {
          policy: { policy: 'softmax_mfi' },
          composeDeps: { loadMemoryPrior, runTaskFn, rng: () => 0 },
        }),
      ),
    );

    // Then one winner performs provider work and materialization without pool starvation.
    expect(results.reduce((sum, added) => sum + added, 0)).toBe(1);
    expect(loadMemoryPrior).toHaveBeenCalledTimes(1);
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });
});

/** @invariant concurrency: Concurrent upload delivery is idempotent and preserves existing learner rows.
 * @fails-if Duplicate GET/backfill inserts a root twice or edits a completed/in-progress row.
 */
it('delivers newly imported roots once across concurrent today reads without editing learner rows', async () => {
  const { db } = createTenConnectionDb();
  const now = new Date(),
    date = streamLocalDate();
  const qid = await seedSamplableQuestion(db);
  await db.insert(schema.practice_stream_item).values({
    id: createId(),
    date,
    position: 1,
    item_kind: 'question',
    ref_id: qid,
    source: 'on_demand',
    status: 'in_progress',
    reasoning: 'keep learner state',
    added_by: 'user',
    signals: { retained: true },
  });
  const before = await db.select().from(schema.practice_stream_item);
  const batchId = createId(),
    documentId = createId();
  await db.insert(schema.source_document).values({
    id: documentId,
    title: 'Public synthetic upload',
    provenance: { usage_policy: { derivation_policy: 'allow' } },
    created_at: now,
    updated_at: now,
  });
  await db.insert(schema.learning_session).values({
    id: batchId,
    type: 'ingestion',
    status: 'completed',
    source_document_id: documentId,
    created_at: now,
    updated_at: now,
  });
  const uploaded = await seedSamplableQuestion(db),
    blockId = createId();
  await db.insert(schema.question_block).values({
    id: blockId,
    ingestion_session_id: batchId,
    source_document_id: documentId,
    created_at: now,
    updated_at: now,
  });
  await db.transaction((tx) =>
    applyQuestionBlockTransition(
      tx,
      { kind: 'complete_import', blockId, questionId: uploaded, attemptEventId: null },
      now,
    ),
  );
  const registry = await loadEventSubscriptionRegistry(
    [
      {
        name: 'practice',
        description: 'Upload delivery invariant',
        events: {
          actions: [
            'experimental:assessment_publish',
            'experimental:question_block_lifecycle',
            'experimental:upload_practice_delivery',
            'experimental:stream_compose_control',
          ],
        },
        subscriptions: {
          handlers: (schedulingManifestPart.subscriptions?.handlers ?? []).filter(
            (handler) => handler.id === 'practice.upload-ready',
          ),
        },
      },
    ],
    db,
  );
  await bootstrapSubscription(db, registry, registry.subscriptions[0]);
  const views = await Promise.all([getPracticeStream(db, {}), getPracticeStream(db, {})]);
  expect(views.map((view) => view.items.filter((row) => row.ref_id === uploaded).length)).toEqual([
    1, 1,
  ]);
  expect(
    await db
      .select()
      .from(schema.practice_stream_item)
      .where(eq(schema.practice_stream_item.id, before[0].id)),
  ).toEqual(before);
  const receipts = await db
    .select()
    .from(schema.event)
    .where(
      and(
        eq(schema.event.action, 'experimental:upload_practice_delivery'),
        eq(schema.event.subject_id, uploaded),
      ),
    );
  expect(receipts).toHaveLength(1);
  const [paid] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.event)
    .where(sql`task_run_id is not null OR cost_micro_usd is not null`);
  expect(paid.count).toBe(0);
});

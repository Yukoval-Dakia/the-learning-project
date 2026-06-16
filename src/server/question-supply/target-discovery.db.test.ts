// YUK-361 Phase 8 (Task 13 Step 6) — 端到端只读发现 + 派发 db 测（真实 Postgres）。
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()，不假设跨文件状态/执行序。

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, knowledge, learning_item, question } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { type DispatchResult, type EnqueueFn, dispatchSupplyTargets } from './dispatcher';
import { discoverSupplyTargets } from './target-discovery';

async function seedKnowledge(id: string, domain = 'wenyan') {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedActiveLearningItem(knowledgeIds: string[]) {
  const now = new Date();
  await db.insert(learning_item).values({
    id: createId(),
    source: 'test',
    title: 'active item',
    content: '',
    knowledge_ids: knowledgeIds,
    status: 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(
  knowledgeIds: string[],
  opts: {
    kind?: string;
    source: string;
    metadata?: Record<string, unknown> | null;
    draft_status?: string | null;
    difficulty?: number;
  },
) {
  const now = new Date();
  const id = createId();
  await db.insert(question).values({
    id,
    kind: opts.kind ?? 'short_answer',
    prompt_md: `Q ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty: opts.difficulty ?? 3,
    source: opts.source,
    metadata: (opts.metadata ?? null) as never,
    draft_status: opts.draft_status ?? null,
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('discoverSupplyTargets — frontier zero questions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('emits a frontier_zero supply target for an active learning item KC with zero questions', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    // ZERO questions.

    const targets = await discoverSupplyTargets(db);
    const frontierTargets = targets.filter((t) => t.gapKind === 'frontier_zero');
    expect(frontierTargets).toHaveLength(1);
    const t = frontierTargets[0];
    expect(t.knowledgeIds).toEqual([kid]);
    expect(t.desiredCount).toBe(2);
    expect(t.subjectId).toBe('wenyan');
    // 零题的 KC 只产 frontier_zero（无池可分析 R2/R3/R4）。
    expect(targets.filter((tt) => tt.knowledgeIds[0] === kid)).toHaveLength(1);
  });

  it('does NOT treat a tracked (scheduled) KC as frontier — no learning item → no target', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    // No active learning_item references it → not a frontier candidate at all.
    const targets = await discoverSupplyTargets(db);
    expect(targets.filter((t) => t.knowledgeIds[0] === kid)).toHaveLength(0);
  });
});

describe('discoverSupplyTargets — higher-tier requirement + suppression', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('an accepted/manual question satisfies the higher-tier requirement and suppresses source_quality', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);

    // A low-tier web_sourced DRAFT (not yet promoted) AND an accepted/manual question.
    await seedQuestion([kid], {
      source: 'web_sourced',
      draft_status: 'draft',
      metadata: {
        source_ref_kind: 'url',
        web_sourced: {
          url: 'https://example.com/q',
          title: 'T',
          fetched_at: '2026-06-15T00:00:00Z',
          whitelist_match: false,
          extract: 'extracted text',
        },
      },
    });
    await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });

    const targets = await discoverSupplyTargets(db);
    const mine = targets.filter((t) => t.knowledgeIds[0] === kid);
    // The manual (acquisition tier 1) question satisfies the higher-tier need →
    // NO source_quality gap.
    expect(mine.find((t) => t.gapKind === 'source_quality')).toBeUndefined();
    // Not a frontier_zero either (questions exist).
    expect(mine.find((t) => t.gapKind === 'frontier_zero')).toBeUndefined();
  });

  it('only low-tier (llm-only) questions → emits a higher-tier source_quality target', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    // Only a low-tier generated quiz_gen question (difficulty 3 → b≈0 ≈ theta_hat 0 → near,
    // suppresses the diagnostic gap so we isolate source_quality).
    await seedQuestion([kid], {
      source: 'quiz_gen',
      metadata: { quiz_gen: { generation_method: 'closed_book' } },
      difficulty: 3,
    });

    const targets = await discoverSupplyTargets(db);
    const sq = targets.find((t) => t.knowledgeIds[0] === kid && t.gapKind === 'source_quality');
    expect(sq).toBeDefined();
    expect(sq?.minSourceTier).toBe(2);
  });
});

describe('dispatchSupplyTargets — wiring + observability', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('dispatches a frontier_zero target to the sourcing queue and logs an experimental:question_supply event', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);

    const targets = await discoverSupplyTargets(db);
    const frontierTarget = targets.find((t) => t.gapKind === 'frontier_zero');
    if (!frontierTarget) throw new Error('expected a frontier_zero target');

    // Capture enqueue (no live pg-boss in test).
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const enqueue: EnqueueFn = async (queue, data) => {
      enqueued.push({ queue, data });
      return `job-${enqueued.length}`;
    };

    const results: DispatchResult[] = await dispatchSupplyTargets(db, [frontierTarget], {
      enqueue,
    });
    expect(results).toHaveLength(1);
    const r = results[0];
    // frontier_zero → minSourceTier 2 → planSupplyRoutes → ['sourcing_web', ...] → 'sourcing'.
    expect(r.status).toBe('dispatched');
    expect(r.chosenRoute).toBe('sourcing_web');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].queue).toBe('sourcing');
    expect(enqueued[0].data).toMatchObject({
      trigger: 'knowledge',
      ref_id: kid,
      knowledge_id: kid,
      count: 2,
    });

    // Observability: an experimental:question_supply event was written for this target.
    const events = await db.select().from(event).where(eq(event.subject_id, frontierTarget.id));
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('experimental:question_supply');
    expect(events[0].subject_kind).toBe('query');
    expect(events[0].outcome).toBe('success');
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.gap_kind).toBe('frontier_zero');
    expect(payload.status).toBe('dispatched');
    expect(payload.route_plan).toEqual(['sourcing_web', 'ingest_existing', 'author_question']);
    expect(payload.chosen_route).toBe('sourcing_web');
    expect(typeof payload.stop_condition).toBe('string');
  });

  // review FINDING #1 + #2 — query-based fingerprint cooldown breaks the unbounded
  // re-dispatch loop. Dispatching the SAME target (same fingerprint, gap still
  // unsatisfied — no fresh active question) twice must NOT enqueue a second job:
  // the second call finds the first dispatch's persisted experimental:question_supply
  // event (status='dispatched') within the cooldown window and SKIPS.
  it('SKIPS a second dispatch of the same unsatisfied fingerprint within the cooldown window (no second enqueue)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);

    const targets = await discoverSupplyTargets(db);
    const frontierTarget = targets.find((t) => t.gapKind === 'frontier_zero');
    if (!frontierTarget) throw new Error('expected a frontier_zero target');

    // Injectable enqueue captures every boss.send (assert via call count).
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const enqueue: EnqueueFn = async (queue, data) => {
      enqueued.push({ queue, data });
      return `job-${enqueued.length}`;
    };

    // First dispatch → real boss.send (enqueued once), writes a dispatched event.
    const [first] = await dispatchSupplyTargets(db, [frontierTarget], { enqueue });
    expect(first.status).toBe('dispatched');
    expect(enqueued).toHaveLength(1);

    // Second dispatch of the SAME fingerprint (gap still unsatisfied) → cooldown SKIP.
    // Re-run the scanner: the KC still has zero questions → same fingerprint reappears.
    const targets2 = await discoverSupplyTargets(db);
    const frontierTarget2 = targets2.find((t) => t.gapKind === 'frontier_zero');
    if (!frontierTarget2) throw new Error('expected a frontier_zero target on re-scan');
    expect(frontierTarget2.fingerprint).toBe(frontierTarget.fingerprint);

    const [second] = await dispatchSupplyTargets(db, [frontierTarget2], { enqueue });
    expect(second.status).toBe('skipped');
    expect(second.stopCondition).toContain('cooldown');
    // The crux: NO second boss.send.
    expect(enqueued).toHaveLength(1);

    // The skip still emits an observability event (status='skipped') for the second target.
    const skipEvents = await db
      .select()
      .from(event)
      .where(eq(event.subject_id, frontierTarget2.id));
    expect(skipEvents).toHaveLength(1);
    expect((skipEvents[0].payload as Record<string, unknown>).status).toBe('skipped');
  });

  // cooldownDays:0 disables the cooldown (escape hatch) — same fingerprint re-dispatches.
  it('cooldownDays=0 disables cooldown → same fingerprint re-dispatches', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);

    const targets = await discoverSupplyTargets(db);
    const frontierTarget = targets.find((t) => t.gapKind === 'frontier_zero');
    if (!frontierTarget) throw new Error('expected a frontier_zero target');

    const enqueued: Array<{ queue: string }> = [];
    const enqueue: EnqueueFn = async (queue) => {
      enqueued.push({ queue });
      return `job-${enqueued.length}`;
    };

    await dispatchSupplyTargets(db, [frontierTarget], { enqueue, cooldownDays: 0 });
    await dispatchSupplyTargets(db, [frontierTarget], { enqueue, cooldownDays: 0 });
    expect(enqueued).toHaveLength(2);
  });

  it('logs a manual (non-auto-dispatch) event for an image-needed target without enqueueing', async () => {
    const kid = createId();
    await seedKnowledge(kid);

    // Hand-build an image-needed target (scanner does not currently set needsImage;
    // this exercises the dispatcher manual path per Task 13 Step 4 fallback).
    const imageTarget = {
      id: createId(),
      fingerprint: 'fp-image',
      gapKind: 'frontier_zero' as const,
      subjectId: 'wenyan',
      knowledgeIds: [kid],
      kind: 'any',
      difficultyBand: 'near' as const,
      desiredCount: 1,
      minSourceTier: 1 as const,
      routePreference: [],
      priority: 1,
      reason: 'image-grounded gap',
      constraints: { needsImage: true },
    };

    const enqueued: Array<{ queue: string }> = [];
    const enqueue: EnqueueFn = async (queue) => {
      enqueued.push({ queue });
      return 'job';
    };

    const [r] = await dispatchSupplyTargets(db, [imageTarget], { enqueue });
    // image_candidate / ingest_existing have no background queue → manual, no enqueue.
    expect(r.status).toBe('manual');
    expect(r.routePlan[0]).toBe('image_candidate');
    expect(enqueued).toHaveLength(0);

    const events = await db.select().from(event).where(eq(event.subject_id, imageTarget.id));
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).status).toBe('manual');
    expect(events[0].outcome).toBe('partial');
  });
});

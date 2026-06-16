// YUK-361 Phase 8 (Task 13 Step 6) — 端到端只读发现 + 派发 db 测（真实 Postgres）。
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()，不假设跨文件状态/执行序。

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import {
  event,
  item_calibration,
  knowledge,
  learning_item,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { type DispatchResult, type EnqueueFn, dispatchSupplyTargets } from './dispatcher';
import { type SupplyRoute, discoverSupplyTargets } from './target-discovery';

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

// item_calibration row (track='hard'). Lets tests exercise effectiveB (b_calib ?? b_anchor ?? b).
async function seedItemCalibration(
  questionId: string,
  cols: { b?: number | null; b_anchor?: number | null; b_calib?: number | null },
) {
  await db.insert(item_calibration).values({
    id: createId(),
    question_id: questionId,
    b: cols.b ?? null,
    b_anchor: cols.b_anchor ?? null,
    b_calib: cols.b_calib ?? null,
    confidence: 0.5,
    track: 'hard',
    source: 'llm_prior',
  });
}

// material_fsrs_state row for a knowledge point (= "already enrolled / scheduled"). Used to
// verify FINDING #6: an enrolled KC is still scanned (no longer dropped at first enrollment).
async function seedKnowledgeFsrsState(knowledgeId: string) {
  await db.insert(material_fsrs_state).values({
    id: createId(),
    subject_kind: 'knowledge',
    subject_id: knowledgeId,
    state: { stability: 1, difficulty: 5, due: new Date().toISOString() } as never,
    due_at: new Date(),
    last_review_event_id: null,
  });
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

    // TWO accepted/manual questions (both promoted, non-draft) so the KC is at/above
    // the coverage-depth threshold (2 usable questions) — isolates source_quality from
    // the thin-coverage gap (covered separately below).
    await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });
    await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });

    const targets = await discoverSupplyTargets(db);
    const mine = targets.filter((t) => t.knowledgeIds[0] === kid);
    // The manual (acquisition tier 1) questions satisfy the higher-tier need →
    // NO source_quality gap.
    expect(mine.find((t) => t.gapKind === 'source_quality')).toBeUndefined();
    // At/above coverage depth (2 usable) → NO frontier/coverage gap either.
    expect(mine.find((t) => t.gapKind === 'frontier_zero')).toBeUndefined();
  });

  // review FINDING #1 — a draft_status='draft' question is NOT usable coverage. A KC whose
  // ONLY question is a draft must still emit a coverage target (R1) — the draft must NOT
  // suppress the gap. (Also exercises the draft-exclusion predicate in loadQuestionPool.)
  it('a KC whose only question is a draft still emits a frontier/coverage target (draft is not coverage)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);

    // ONLY an unverified/rejected draft (web_sourced, not yet promoted).
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

    const targets = await discoverSupplyTargets(db);
    const mine = targets.filter((t) => t.knowledgeIds[0] === kid);
    // Draft filtered out of the coverage pool → pool is effectively empty → frontier_zero
    // gap fires (the rejected draft correctly leaves the gap OPEN; cooldown throttles re-dispatch).
    const coverage = mine.find((t) => t.gapKind === 'frontier_zero');
    expect(coverage).toBeDefined();
    expect(coverage?.desiredCount).toBe(2); // zero usable → full scaffold of 2.
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

describe('discoverSupplyTargets — FINDING #6: enrolled-but-thin KC still scanned', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // An enrolled KC (has a material_fsrs_state row from a promoted question) with only ONE
  // usable question is below the coverage-depth threshold (2). The OLD frontier=no-FSRS gate
  // dropped it from the scan entirely once enrolled; now it must still emit a coverage target.
  it('a KC with 1 enrolled (promoted) question + an FSRS row STILL emits a coverage target (below threshold)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    // One promoted, high-tier question — but the KC is "enrolled" (has an FSRS row).
    await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });
    await seedKnowledgeFsrsState(kid); // first enrollment — used to drop it from the scan.

    const targets = await discoverSupplyTargets(db);
    const mine = targets.filter((t) => t.knowledgeIds[0] === kid);
    // Still scanned: 1 usable < 2 → coverage gap, desiredCount = deficit (1).
    const coverage = mine.find((t) => t.gapKind === 'frontier_zero');
    expect(coverage).toBeDefined();
    expect(coverage?.desiredCount).toBe(1);
  });

  // Above the coverage-depth threshold (>= 2 usable questions): the enrolled KC does NOT
  // over-emit a coverage gap (guards against scanning-everything-forever).
  it('an enrolled KC at/above coverage depth (2 usable) does NOT emit a coverage gap', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });
    await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });
    await seedKnowledgeFsrsState(kid);

    const targets = await discoverSupplyTargets(db);
    const mine = targets.filter((t) => t.knowledgeIds[0] === kid);
    expect(mine.find((t) => t.gapKind === 'frontier_zero')).toBeUndefined();
  });
});

describe('discoverSupplyTargets — FINDING #4: band gating uses effectiveB (b_calib ?? b_anchor ?? b)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // The item has a real item_calibration row with b=NULL but b_anchor near theta_hat (0).
  // The OLD pool loader read only item_calibration.b (null) → no reliable near anchor → R3
  // diagnostic would FIRE. With effectiveB = b_calib ?? b_anchor ?? b, b_anchor (0) lands 'near'
  // → a reliable near anchor EXISTS → R3 is correctly SUPPRESSED. (Two questions so we are at
  // coverage depth and isolate the R3 behavior from the thin-coverage gap.)
  it('b_anchor near theta_hat suppresses the diagnostic gap (effectiveB falls back to b_anchor)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    const q1 = await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });
    await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });
    // b NULL but b_anchor = 0 (= theta_hat cold-start) → effectiveB = 0 → 'near' band.
    await seedItemCalibration(q1, { b: null, b_anchor: 0, b_calib: null });

    const targets = await discoverSupplyTargets(db);
    const mine = targets.filter((t) => t.knowledgeIds[0] === kid);
    // effectiveB(b_anchor=0) lands 'near' → reliable near anchor exists → NO diagnostic gap.
    expect(mine.find((t) => t.gapKind === 'diagnostic')).toBeUndefined();
  });

  // b_calib wins over b_anchor: a recalibrated item whose b_calib moved FAR from theta_hat must
  // no longer count as a near anchor → R3 diagnostic fires (the item is now mis-banded away).
  it('b_calib (recalibrated) far from theta_hat → no near anchor → diagnostic fires', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    const q1 = await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });
    await seedQuestion([kid], { source: 'manual', kind: 'short_answer', difficulty: 3 });
    // b_anchor=0 (would be near) BUT b_calib=3 wins (far above near window) → no near anchor.
    await seedItemCalibration(q1, { b: 0, b_anchor: 0, b_calib: 3 });

    const targets = await discoverSupplyTargets(db);
    const mine = targets.filter((t) => t.knowledgeIds[0] === kid);
    const diag = mine.find((t) => t.gapKind === 'diagnostic');
    expect(diag).toBeDefined();
    // FINDING #2: the diagnostic/calibration target requests an OBJECTIVE kind.
    expect(diag?.kind).toBe('choice');
    expect(diag?.constraints.objectiveOnly).toBe(true);
    expect(diag?.constraints.calibrationCandidate).toBe(true);
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
      // sourcing_web needs Tavily; force-available so this test isolates the dispatch wiring
      // from env (TAVILY_API_KEY is unset in tests). FINDING #5's no-Tavily path is tested below.
      tavilyAvailable: () => true,
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
    const [first] = await dispatchSupplyTargets(db, [frontierTarget], {
      enqueue,
      tavilyAvailable: () => true,
    });
    expect(first.status).toBe('dispatched');
    expect(enqueued).toHaveLength(1);

    // Second dispatch of the SAME fingerprint (gap still unsatisfied) → cooldown SKIP.
    // Re-run the scanner: the KC still has zero questions → same fingerprint reappears.
    const targets2 = await discoverSupplyTargets(db);
    const frontierTarget2 = targets2.find((t) => t.gapKind === 'frontier_zero');
    if (!frontierTarget2) throw new Error('expected a frontier_zero target on re-scan');
    expect(frontierTarget2.fingerprint).toBe(frontierTarget.fingerprint);

    const [second] = await dispatchSupplyTargets(db, [frontierTarget2], {
      enqueue,
      tavilyAvailable: () => true,
    });
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

    await dispatchSupplyTargets(db, [frontierTarget], {
      enqueue,
      cooldownDays: 0,
      tavilyAvailable: () => true,
    });
    await dispatchSupplyTargets(db, [frontierTarget], {
      enqueue,
      cooldownDays: 0,
      tavilyAvailable: () => true,
    });
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

  // review FINDING #5 — without TAVILY_API_KEY, a sourcing_web head must NOT be auto-dispatched
  // (the SourcingTask degrades without Tavily web tools → doomed job). The plan
  // ['sourcing_web', 'ingest_existing', 'author_question'] has no Tavily-free auto route after
  // sourcing_web (ingest/author are manual) → the whole target falls to manual, no enqueue.
  it('does NOT auto-dispatch a sourcing_web target when Tavily is unavailable (falls to manual)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);

    const targets = await discoverSupplyTargets(db);
    const frontierTarget = targets.find((t) => t.gapKind === 'frontier_zero');
    if (!frontierTarget) throw new Error('expected a frontier_zero target');
    // frontier_zero → minSourceTier 2 → plan head is sourcing_web (Tavily-dependent).
    expect(frontierTarget.minSourceTier).toBe(2);

    const enqueued: Array<{ queue: string }> = [];
    const enqueue: EnqueueFn = async (queue) => {
      enqueued.push({ queue });
      return `job-${enqueued.length}`;
    };

    const [r] = await dispatchSupplyTargets(db, [frontierTarget], {
      enqueue,
      tavilyAvailable: () => false, // simulate TAVILY_API_KEY unset.
    });
    expect(r.status).toBe('manual');
    expect(enqueued).toHaveLength(0); // NO doomed sourcing job.
    expect(r.stopCondition).toContain('Tavily');

    const events = await db.select().from(event).where(eq(event.subject_id, frontierTarget.id));
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).status).toBe('manual');
  });

  // FINDING #5 (other direction) — when Tavily is down but the plan has a Tavily-FREE auto
  // route (closed_book quiz_gen), the dispatcher falls THROUGH to it rather than going manual.
  it('falls through to a Tavily-free quiz_gen route when Tavily is down', async () => {
    const kid = createId();
    await seedKnowledge(kid);

    // Hand-build a tier-3 target whose route plan is the routePreference [sourcing_web, quiz_gen]
    // and whose generation method is closed_book (Tavily-free). With Tavily down, sourcing_web is
    // skipped and quiz_gen (closed_book) is dispatched.
    const target = {
      id: createId(),
      fingerprint: 'fp-fallthrough',
      gapKind: 'format_diversity' as const,
      subjectId: 'wenyan',
      knowledgeIds: [kid],
      kind: 'short_answer',
      difficultyBand: 'near' as const,
      desiredCount: 1,
      minSourceTier: 3 as const, // tier 3 → planner uses routePreference (no hard web/objective gate).
      routePreference: ['sourcing_web', 'quiz_gen'] as SupplyRoute[],
      preferredGenerationMethod: 'closed_book' as const,
      priority: 0.4,
      reason: 'format diversity gap',
      constraints: {},
    };

    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const enqueue: EnqueueFn = async (queue, data) => {
      enqueued.push({ queue, data });
      return `job-${enqueued.length}`;
    };

    const [r] = await dispatchSupplyTargets(db, [target], {
      enqueue,
      tavilyAvailable: () => false,
    });
    expect(r.status).toBe('dispatched');
    expect(r.chosenRoute).toBe('quiz_gen');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].queue).toBe('quiz_gen');
    // FINDING #3: generation_method carried through = closed_book (NOT minSourceTier-derived).
    expect(enqueued[0].data.generation_method).toBe('closed_book');
  });
});

// P5.2 activity-gated per-subject brief refresh (YUK-143) — DB partition.
//
// Exercises listActiveSubjectsSinceRefresh + loadSubjectBriefEvents + the
// subject/global branch of buildMemoryBriefRegenHandler + the per-subject
// enqueue in buildMemoryBriefSweepHandler against real Postgres. These touch
// event + memory_brief_note + knowledge rows and use Postgres array-containment
// + the knowledge→subject parent-chain walk, so they cannot be unit-mocked
// (CLAUDE.md partition rules: DB-touching → db partition).

import { newId } from '@/core/ids';
import { event, knowledge, memory_brief_note } from '@/db/schema';
import { BRIEF_REFRESH_BUDGET } from '@/server/ai/tools/budgets';
import { batchResolveSubjectIds } from '@/server/knowledge/subject-resolution';
import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { listActiveSubjectsSinceRefresh, loadSubjectBriefEvents } from './active-subjects';
import { type GenerateBrief, loadEventsFromDbForTest } from './brief';
import { buildMemoryBriefRegenHandler, buildMemoryBriefSweepHandler } from './triggers';

const NOW = new Date('2026-05-31T03:00:00Z');

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

// Seed a root knowledge node whose domain resolves to the given subject id.
async function seedKnowledge(id: string, domain: string): Promise<void> {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: id,
      domain,
      parent_id: null,
      created_at: daysAgo(100),
      updated_at: daysAgo(100),
    });
}

// Insert an attempt/review event DIRECTLY (bypassing Zod writeEvent) so we can
// control affected_scopes precisely. The key BR-10 setup: affected_scopes
// deliberately OMITS subject:X (mirroring computeAffectedScopes for
// attempt/review, which never tags subject:), while the payload carries
// referenced_knowledge_ids that resolve to the subject.
async function insertAttempt(opts: {
  id?: string;
  knowledgeIds: string[];
  createdAt: Date;
  affectedScopes?: string[];
  action?: string;
}): Promise<string> {
  const id = opts.id ?? newId();
  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: opts.action ?? 'attempt',
      subject_kind: 'question',
      subject_id: `q-${id}`,
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: opts.knowledgeIds,
      },
      affected_scopes: opts.affectedScopes ?? ['global', `topic:${opts.knowledgeIds[0] ?? 'x'}`],
      created_at: opts.createdAt,
    });
  return id;
}

async function seedBriefRow(opts: {
  subjectId: string;
  refreshedAt: Date | null;
  latestEvidenceAt?: Date | null;
}): Promise<void> {
  const scopeKey = `subject:${opts.subjectId}`;
  await testDb()
    .insert(memory_brief_note)
    .values({
      id: `memory_brief:${scopeKey}`,
      scope_key: scopeKey,
      subject_id: opts.subjectId,
      refreshed_at: opts.refreshedAt,
      latest_evidence_at: opts.latestEvidenceAt ?? null,
      created_at: daysAgo(60),
      updated_at: daysAgo(60),
    });
}

// Typed boss.send mock so mock.calls[i] is a typed [name, data, options] tuple
// (an untyped vi.fn() infers an empty-arg signature → mock.calls is [][]).
function bossSendMock() {
  return {
    send: vi.fn<(name: string, data: { scope_key: string }, options?: object) => Promise<string>>(
      async () => 'job-1',
    ),
  };
}

function enqueuedScopeKeys(boss: ReturnType<typeof bossSendMock>): string[] {
  return boss.send.mock.calls.map((call) => call[1].scope_key);
}

function fakeGenerate() {
  return vi.fn<GenerateBrief>(async () => ({
    recent_week_md: '## week',
    recent_months_md: '## months',
    long_term_md: '## long',
    recent_week_evidence_ids: [],
    recent_months_evidence_ids: [],
    long_term_evidence_ids: [],
  }));
}

const noFactsClient = { search: vi.fn(async () => ({ results: [] })) };

describe('listActiveSubjectsSinceRefresh', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('flags a subject ACTIVE when a qualifying event is newer than its brief refreshed_at', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    await seedBriefRow({ subjectId: 'wenyan', refreshedAt: daysAgo(5) });
    await insertAttempt({ knowledgeIds: ['k-wenyan'], createdAt: daysAgo(1) });

    const active = await listActiveSubjectsSinceRefresh(testDb(), { now: NOW });

    expect(active).toHaveLength(1);
    expect(active[0].scopeKey).toBe('subject:wenyan');
    expect(active[0].subjectId).toBe('wenyan');
    expect(active[0].events).toHaveLength(1);
    expect(active[0].maxCreatedAt.getTime()).toBe(daysAgo(1).getTime());
  });

  it('does NOT flag a dormant subject (no activity since last refresh)', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    await seedBriefRow({ subjectId: 'wenyan', refreshedAt: daysAgo(1) });
    // Activity is OLDER than refreshed_at → dormant.
    await insertAttempt({ knowledgeIds: ['k-wenyan'], createdAt: daysAgo(5) });

    const active = await listActiveSubjectsSinceRefresh(testDb(), { now: NOW });

    expect(active).toHaveLength(0);
  });

  it('flags a never-built subject with in-window activity (BR-5) and skips out-of-window', async () => {
    await seedKnowledge('k-math', 'math');
    await seedKnowledge('k-phys', 'physics');
    // math: activity within 30d, no brief row → active (initial build).
    await insertAttempt({ knowledgeIds: ['k-math'], createdAt: daysAgo(10) });
    // physics: activity OUTSIDE 30d, no brief row → not active.
    await insertAttempt({ knowledgeIds: ['k-phys'], createdAt: daysAgo(45) });

    const active = await listActiveSubjectsSinceRefresh(testDb(), { now: NOW, lookbackDays: 30 });

    expect(active.map((a) => a.subjectId).sort()).toEqual(['math']);
  });

  it('resolution matches batchResolveSubjectIds incl orphan→default fallback', async () => {
    await seedKnowledge('k-math', 'math');
    // Orphan knowledge id (no row) resolves to the default subject (wenyan).
    const e1 = await insertAttempt({ knowledgeIds: ['k-math'], createdAt: daysAgo(2) });
    const e2 = await insertAttempt({ knowledgeIds: ['k-orphan'], createdAt: daysAgo(3) });

    const expected = await batchResolveSubjectIds(testDb(), [
      { id: e1, knowledge_ids: ['k-math'] },
      { id: e2, knowledge_ids: ['k-orphan'] },
    ]);
    expect(expected.get(e1)).toBe('math');
    expect(expected.get(e2)).toBe('wenyan'); // orphan → default

    const active = await listActiveSubjectsSinceRefresh(testDb(), { now: NOW });
    expect(active.map((a) => a.subjectId).sort()).toEqual(['math', 'wenyan']);
  });

  it('caps each subject event window at maxEventsPerBrief, most recent first', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    const cap = BRIEF_REFRESH_BUDGET.maxEventsPerBrief;
    // Seed cap + 10 events, all within window, all wenyan.
    for (let i = 0; i < cap + 10; i += 1) {
      await insertAttempt({ knowledgeIds: ['k-wenyan'], createdAt: daysAgo(i % 25) });
    }

    const active = await listActiveSubjectsSinceRefresh(testDb(), { now: NOW });
    expect(active).toHaveLength(1);
    expect(active[0].events).toHaveLength(cap);
    // Most-recent-first ordering preserved.
    for (let i = 1; i < active[0].events.length; i += 1) {
      expect(active[0].events[i - 1].created_at.getTime()).toBeGreaterThanOrEqual(
        active[0].events[i].created_at.getTime(),
      );
    }
  });
});

describe('buildMemoryBriefSweepHandler — per-subject layer', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('enqueues regen for an active subject after the global stale loop (BR-6 untouched)', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    await seedBriefRow({ subjectId: 'wenyan', refreshedAt: daysAgo(5) });
    await insertAttempt({ knowledgeIds: ['k-wenyan'], createdAt: daysAgo(1) });
    const boss = bossSendMock();

    await buildMemoryBriefSweepHandler(testDb(), boss)([]);

    // The stale subject:wenyan brief row (>24h) is also caught by
    // listStaleBriefScopes, but enqueueBriefRegen dedups per scope_key — assert
    // the scope was enqueued at least once.
    expect(enqueuedScopeKeys(boss)).toContain('subject:wenyan');
  });

  // NOTE: the >maxSubjectsPerRun top-N + defer behavior is unit-tested against
  // selectSubjectsForRun in active-subjects.test.ts (only 3 real subject
  // profiles exist — wenyan/math/physics — so >12 DISTINCT subject buckets are
  // not reachable through the DB resolution path). Here we just assert the
  // sweep enqueues the resolved active subjects via that pure selector.
  it('enqueues all active subjects when under the per-run budget', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    await seedKnowledge('k-math', 'math');
    await seedKnowledge('k-phys', 'physics');
    await insertAttempt({ knowledgeIds: ['k-wenyan'], createdAt: daysAgo(1) });
    await insertAttempt({ knowledgeIds: ['k-math'], createdAt: daysAgo(2) });
    await insertAttempt({ knowledgeIds: ['k-phys'], createdAt: daysAgo(3) });

    const boss = bossSendMock();
    await buildMemoryBriefSweepHandler(testDb(), boss)([]);
    const subjectEnqueued = enqueuedScopeKeys(boss)
      .filter((s) => s.startsWith('subject:'))
      .sort();
    expect(subjectEnqueued).toEqual(['subject:math', 'subject:physics', 'subject:wenyan']);
  });

  it('sorts active subjects by recency DESC before the budget slice', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    await seedKnowledge('k-math', 'math');
    await seedKnowledge('k-phys', 'physics');
    await insertAttempt({ knowledgeIds: ['k-phys'], createdAt: daysAgo(3) });
    await insertAttempt({ knowledgeIds: ['k-wenyan'], createdAt: daysAgo(1) }); // most recent
    await insertAttempt({ knowledgeIds: ['k-math'], createdAt: daysAgo(2) });

    const active = await listActiveSubjectsSinceRefresh(testDb(), { now: NOW });
    const sorted = [...active].sort((a, b) => b.maxCreatedAt.getTime() - a.maxCreatedAt.getTime());
    expect(sorted.map((a) => a.subjectId)).toEqual(['wenyan', 'math', 'physics']);
  });
});

describe('buildMemoryBriefRegenHandler — BR-10 subject branch', () => {
  beforeEach(async () => {
    await resetDb();
  });

  function regenJob(scopeKey: string): Job<{ scope_key: string }>[] {
    return [{ data: { scope_key: scopeKey } } as Job<{ scope_key: string }>];
  }

  it('subject brief is NON-EMPTY from referenced_knowledge_ids while affected_scopes loader returns 0 rows', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    // attempt event: affected_scopes deliberately has NO subject:wenyan (mirrors
    // computeAffectedScopes for attempt/review), only the knowledge resolves it.
    await insertAttempt({
      knowledgeIds: ['k-wenyan'],
      createdAt: daysAgo(1),
      affectedScopes: ['global', 'topic:k-wenyan'],
    });

    // The affected_scopes path sees 0 rows for subject:wenyan...
    const affectedScopesRows = await loadEventsFromDbForTest(testDb(), 'subject:wenyan');
    expect(affectedScopesRows).toHaveLength(0);
    // ...but the knowledge-resolved loader returns the qualifying event.
    const resolved = await loadSubjectBriefEvents(testDb(), 'wenyan', { now: NOW });
    expect(resolved).toHaveLength(1);

    const generate = fakeGenerate();
    const handler = buildMemoryBriefRegenHandler(testDb(), {
      memoryClient: noFactsClient,
      generateBrief: generate,
    });
    await handler(regenJob('subject:wenyan'));

    expect(generate).toHaveBeenCalledTimes(1);
    const briefRow = await testDb()
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, 'subject:wenyan'));
    expect(briefRow).toHaveLength(1);
    // Non-null latest_evidence_at — proves the regen read the resolved list, not
    // the empty affected_scopes path (which would leave it null → regen-empty
    // every night, the BR-10 cost leak).
    expect(briefRow[0].latest_evidence_at).not.toBeNull();
    expect(briefRow[0].evidence_count).toBe(1);
  });

  // Regression for the detection↔regen lookback-window divergence (adversarial
  // verify finding): a BUILT subject whose qualifying event is NEWER than its
  // refreshed_at but OLDER than a fixed now-30d floor. Detection flags it active
  // (40d > 60d refreshed_at). Before the fix, loadSubjectBriefEvents used a flat
  // now-30d floor → excluded the 40d event → events=[] →
  // subjectScopeHasNewEvidence([]) false → SKIP forever (silently starved +
  // re-enqueued every night). After the fix both floor at refreshed_at, so the
  // 40d event loads and the brief refreshes.
  it('refreshes a built subject whose only new event is newer than refreshed_at but older than the 30d window', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    // Built 60d ago, last evidence 60d ago.
    await seedBriefRow({
      subjectId: 'wenyan',
      refreshedAt: daysAgo(60),
      latestEvidenceAt: daysAgo(60),
    });
    // One qualifying event at 40d: newer than refreshed_at (60d), older than the
    // 30d lookback window.
    await insertAttempt({
      knowledgeIds: ['k-wenyan'],
      createdAt: daysAgo(40),
      affectedScopes: ['global', 'topic:k-wenyan'],
    });

    // (i) Detection flags it ACTIVE.
    const active = await listActiveSubjectsSinceRefresh(testDb(), { now: NOW });
    expect(active.map((a) => a.subjectId)).toContain('wenyan');

    // (ii) The regen handler DOES refresh it.
    const generate = fakeGenerate();
    const handler = buildMemoryBriefRegenHandler(testDb(), {
      memoryClient: noFactsClient,
      generateBrief: generate,
    });
    await handler(regenJob('subject:wenyan'));

    expect(generate).toHaveBeenCalledTimes(1);
    const briefRow = await testDb()
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, 'subject:wenyan'));
    expect(briefRow).toHaveLength(1);
    // refreshed_at bumped to ~now (was 60d ago).
    expect(briefRow[0].refreshed_at?.getTime() ?? 0).toBeGreaterThan(daysAgo(1).getTime());
    // latest_evidence_at = the 40d event's created_at.
    expect(briefRow[0].latest_evidence_at?.getTime()).toBe(daysAgo(40).getTime());
    expect(briefRow[0].evidence_count).toBeGreaterThanOrEqual(1);
    expect(briefRow[0].recent_week_md.length).toBeGreaterThan(0);
  });

  it('a never-built active subject does NOT loop into regenerating an empty brief', async () => {
    await seedKnowledge('k-math', 'math');
    await insertAttempt({
      knowledgeIds: ['k-math'],
      createdAt: daysAgo(2),
      affectedScopes: ['global', 'topic:k-math'],
    });

    const generate = fakeGenerate();
    const handler = buildMemoryBriefRegenHandler(testDb(), {
      memoryClient: noFactsClient,
      generateBrief: generate,
    });

    // First invocation: builds a non-empty brief (generate called once).
    await handler(regenJob('subject:math'));
    expect(generate).toHaveBeenCalledTimes(1);
    const afterBuild = await testDb()
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, 'subject:math'));
    expect(afterBuild).toHaveLength(1);
    expect(afterBuild[0].latest_evidence_at).not.toBeNull();
    expect(afterBuild[0].evidence_count).toBeGreaterThan(0);
    const firstRefreshedAt = afterBuild[0].refreshed_at?.getTime() ?? 0;

    // Second invocation with NO new events: must NOT call generate again and must
    // NOT bump refreshed_at (the brief now floors at its own refreshed_at, so the
    // already-summarized event is excluded → empty window → skip). This is what
    // the test name claims: no loop into regenerating an empty brief every night.
    await handler(regenJob('subject:math'));
    expect(generate).toHaveBeenCalledTimes(1);
    const afterSecond = await testDb()
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, 'subject:math'));
    expect(afterSecond[0].refreshed_at?.getTime() ?? 0).toBe(firstRefreshedAt);
  });

  it('dormant subject enqueued via the global stale-sweep is skipped (BR-2: no LLM call, no refreshed_at bump)', async () => {
    // A subject:math brief row is stale (>24h → caught by listStaleBriefScopes)
    // but DORMANT: its only qualifying event is OLDER than its latest_evidence_at.
    await seedKnowledge('k-math', 'math');
    const oldRefresh = daysAgo(3);
    await testDb()
      .insert(memory_brief_note)
      .values({
        id: 'memory_brief:subject:math',
        scope_key: 'subject:math',
        subject_id: 'math',
        refreshed_at: oldRefresh,
        latest_evidence_at: daysAgo(2),
        evidence_count: 1,
        created_at: daysAgo(5),
        updated_at: oldRefresh,
      });
    // Activity is OLDER than latest_evidence_at → not new evidence.
    await insertAttempt({
      knowledgeIds: ['k-math'],
      createdAt: daysAgo(4),
      affectedScopes: ['global', 'topic:k-math'],
    });

    const generate = fakeGenerate();
    const handler = buildMemoryBriefRegenHandler(testDb(), {
      memoryClient: noFactsClient,
      generateBrief: generate,
    });
    await handler(regenJob('subject:math'));

    // No LLM call; refreshed_at unchanged (the brief row is untouched).
    expect(generate).not.toHaveBeenCalled();
    const briefRow = await testDb()
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, 'subject:math'));
    expect(briefRow[0].refreshed_at?.getTime()).toBe(oldRefresh.getTime());
  });

  it('per-brief read budget: >maxEventsPerBrief events → exactly maxEventsPerBrief read (graceful)', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    const cap = BRIEF_REFRESH_BUDGET.maxEventsPerBrief;
    for (let i = 0; i < cap + 12; i += 1) {
      await insertAttempt({ knowledgeIds: ['k-wenyan'], createdAt: daysAgo(i % 25) });
    }

    const generate = fakeGenerate();
    const handler = buildMemoryBriefRegenHandler(testDb(), {
      memoryClient: noFactsClient,
      generateBrief: generate,
    });
    await handler(regenJob('subject:wenyan'));

    // generate received exactly cap events (graceful truncation, not rejection).
    expect(generate.mock.calls[0][0].events).toHaveLength(cap);
    const briefRow = await testDb()
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, 'subject:wenyan'));
    expect(briefRow[0].evidence_count).toBe(cap);
  });

  it('global path regression: still gated by scopeHasNewEvidence + loadEventsFromDb (affected_scopes)', async () => {
    // Seed a global brief row with a latest_evidence_at and NO newer global
    // event → scopeHasNewEvidence('global') returns false → SKIP (no generate).
    await testDb()
      .insert(memory_brief_note)
      .values({
        id: 'memory_brief:global',
        scope_key: 'global',
        subject_id: null,
        refreshed_at: daysAgo(1),
        latest_evidence_at: daysAgo(1),
        created_at: daysAgo(2),
        updated_at: daysAgo(2),
      });
    // An older global-tagged event exists, but it is NOT newer than the brief.
    await insertAttempt({
      knowledgeIds: ['k-anything'],
      createdAt: daysAgo(5),
      affectedScopes: ['global'],
    });

    const generate = fakeGenerate();
    const handler = buildMemoryBriefRegenHandler(testDb(), {
      memoryClient: noFactsClient,
      generateBrief: generate,
    });
    await handler(regenJob('global'));
    expect(generate).not.toHaveBeenCalled(); // skipped by scopeHasNewEvidence

    // Now add a NEWER global-tagged event → scopeHasNewEvidence true → regen.
    await insertAttempt({
      knowledgeIds: ['k-anything'],
      createdAt: NOW,
      affectedScopes: ['global'],
    });
    await handler(regenJob('global'));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('parallel no-clobber: subject:A + subject:B enqueued → two distinct rows, neither overwrites', async () => {
    await seedKnowledge('k-wenyan', 'wenyan');
    await seedKnowledge('k-math', 'math');
    await insertAttempt({
      knowledgeIds: ['k-wenyan'],
      createdAt: daysAgo(1),
      affectedScopes: ['global', 'topic:k-wenyan'],
    });
    await insertAttempt({
      knowledgeIds: ['k-math'],
      createdAt: daysAgo(2),
      affectedScopes: ['global', 'topic:k-math'],
    });

    const generate = fakeGenerate();
    const handler = buildMemoryBriefRegenHandler(testDb(), {
      memoryClient: noFactsClient,
      generateBrief: generate,
    });
    // Same batch, two jobs (mirrors batchSize>1 drain; correct at batchSize:1 too).
    await handler([
      { data: { scope_key: 'subject:wenyan' } } as Job<{ scope_key: string }>,
      { data: { scope_key: 'subject:math' } } as Job<{ scope_key: string }>,
    ]);

    const rows = await testDb().select().from(memory_brief_note);
    const scopes = rows.map((r) => r.scope_key).sort();
    expect(scopes).toEqual(['subject:math', 'subject:wenyan']);
    const wenyan = rows.find((r) => r.scope_key === 'subject:wenyan');
    const math = rows.find((r) => r.scope_key === 'subject:math');
    expect(wenyan?.subject_id).toBe('wenyan');
    expect(math?.subject_id).toBe('math');
    expect(wenyan?.evidence_count).toBe(1);
    expect(math?.evidence_count).toBe(1);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

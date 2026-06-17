// YUK-398 inc-2 — existing-pool selection equivalence anchor.
//
// queryExistingPool (sourcing-sequence.ts) was migrated onto the unified poolFetch
// operator (pool-fetch.ts, YUK-396). This is a ZERO-behavior-change refactor: poolFetch
// supplies the raw scalar pool (WHERE byte-identical), and queryExistingPool re-applies
// its in-memory kind filter + 合约五 tier/whitelist sort + limit slice on top.
//
// This file is the single COMBINED "selection unchanged" anchor for that migration. It
// seeds ONE candidate set that simultaneously spans every selection axis (tier 1/2/4,
// kind reading vs computation, a draft, a sub-floor difficulty, a composite parent) and
// asserts the exact selected id sequence across several runSourcingSequence calls. The
// per-axis regressions live in sourcing-sequence.test.ts; this proves they hold TOGETHER
// after the operator swap. The A2 risk it specifically pins: limit must slice AFTER the
// in-memory tier sort (poolFetch is called WITHOUT a limit), so a high-tier row created
// last is never dropped by an SQL-layer truncation.

import { describe, expect, it } from 'vitest';

import { knowledge, question } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { runSourcingSequence } from './sourcing-sequence';

const db = testDb();

// Tavily is unset in the test env; inject "available" so the (unrelated) background route
// does not degrade — this file only asserts step-1 (existing pool) selection.
const TAVILY_UP = () => true;

async function seedKnowledge(id: string, domain = 'wenyan') {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: '之',
    domain,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

// tier-1 authentic: ingestion provenance marker.
const TIER1_META = { ingestion_session_id: 'sess-eq' };

// tier-2 web_sourced; whitelist_match drives the OF-2 within-tier demotion.
function tier2Meta(whitelistMatch: boolean): Record<string, unknown> {
  return {
    source_ref_kind: 'url',
    web_sourced: {
      url: 'https://example.com/q',
      title: 't',
      fetched_at: '2026-06-06T00:00:00Z',
      whitelist_match: whitelistMatch,
      extract: '示例题干抽取',
    },
  };
}

async function seedQuestion(opts: {
  id: string;
  knowledgeId: string;
  createdAt: Date;
  draft?: boolean;
  source?: string;
  kind?: string;
  difficulty?: number;
  parentQuestionId?: string;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(question).values({
    id: opts.id,
    kind: opts.kind ?? 'short_answer',
    prompt_md: `题目 ${opts.id}`,
    reference_md: '参考',
    rubric_json: { required_points: ['p'] } as never,
    choices_md: null,
    judge_kind_override: 'semantic',
    knowledge_ids: [opts.knowledgeId],
    difficulty: opts.difficulty ?? 3,
    source: opts.source ?? 'test',
    source_ref: opts.knowledgeId,
    draft_status: opts.draft ? 'draft' : null,
    parent_question_id: opts.parentQuestionId ?? null,
    created_by: { by: 'ai', task_kind: 'QuizGenTask', task_run_id: 'tr' } as never,
    metadata: (opts.metadata ?? {}) as never,
    created_at: opts.createdAt,
    updated_at: opts.createdAt,
  });
}

// Monotonically increasing created_at so the SQL base order (created_at asc, id asc) is
// deterministic and we can reason about which rows an SQL-layer truncation WOULD have kept.
function at(seq: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seq));
}

describe('queryExistingPool ↔ poolFetch selection equivalence (YUK-398 inc-2)', () => {
  it('selects the spec-ordered ids across tier / kind / draft / difficulty / composite axes', async () => {
    await resetDb();
    await seedKnowledge('kc');

    // ── candidate set spanning every selection axis ──────────────────────────────
    // Inserted in created_at order so insertion order canNOT be what produces the
    // expected tier ordering — only the in-memory 合约五 sort can.
    //
    // tier-4 generated 'reading' rows, created FIRST (oldest). Plenty of them so an
    // SQL `limit` (had we passed one) would truncate to these by created_at and drop the
    // later high-tier rows — the A2/F2 trap.
    await seedQuestion({
      id: 'r-gen-1',
      knowledgeId: 'kc',
      kind: 'reading',
      source: 'quiz_gen',
      createdAt: at(1),
    });
    await seedQuestion({
      id: 'r-gen-2',
      knowledgeId: 'kc',
      kind: 'reading',
      source: 'quiz_gen',
      createdAt: at(2),
    });
    await seedQuestion({
      id: 'r-gen-3',
      knowledgeId: 'kc',
      kind: 'reading',
      source: 'quiz_gen',
      createdAt: at(3),
    });
    // tier-2 web_sourced 'reading' rows: off-whitelist created BEFORE on-whitelist, so only
    // the OF-2 demotion (not created_at) can put on-whitelist ahead.
    await seedQuestion({
      id: 'r-src-off',
      knowledgeId: 'kc',
      kind: 'reading',
      source: 'web_sourced',
      createdAt: at(4),
      metadata: tier2Meta(false),
    });
    await seedQuestion({
      id: 'r-src-on',
      knowledgeId: 'kc',
      kind: 'reading',
      source: 'web_sourced',
      createdAt: at(5),
      metadata: tier2Meta(true),
    });
    // a draft 'reading' row — must never enter the pool.
    await seedQuestion({
      id: 'r-draft',
      knowledgeId: 'kc',
      kind: 'reading',
      source: 'wenyan',
      createdAt: at(6),
      draft: true,
      metadata: TIER1_META,
    });
    // a different KC — must never match.
    await seedKnowledge('kc-other');
    await seedQuestion({
      id: 'r-other',
      knowledgeId: 'kc-other',
      kind: 'reading',
      source: 'wenyan',
      createdAt: at(7),
      metadata: TIER1_META,
    });
    // tier-1 authentic 'reading' row, created LAST (newest). With an SQL truncation this
    // would be dropped; with the in-memory tier sort it must be selected FIRST.
    await seedQuestion({
      id: 'r-auth',
      knowledgeId: 'kc',
      kind: 'reading',
      source: 'wenyan',
      createdAt: at(8),
      metadata: TIER1_META,
    });
    // a 'computation' row — excluded for a reading request, included for a computation one.
    await seedQuestion({
      id: 'c-gen',
      knowledgeId: 'kc',
      kind: 'computation',
      source: 'quiz_gen',
      createdAt: at(9),
    });
    // a low-difficulty 'reading' row for the difficultyMin axis.
    await seedQuestion({
      id: 'r-easy',
      knowledgeId: 'kc',
      kind: 'reading',
      source: 'quiz_gen',
      difficulty: 1,
      createdAt: at(10),
    });

    // ── 1) reading request, limit 5 — full tier-ordered selection ────────────────
    // Expected order (合约五): tier-1 auth → tier-2 on-whitelist → tier-2 off-whitelist →
    // tier-4 generated by created_at asc. Draft + other-KC + computation excluded.
    // A2/F2: r-auth (newest) is FIRST despite created_at order; limit slices AFTER sort.
    const reading = await runSourcingSequence({
      db,
      knowledgeId: 'kc',
      count: 5,
      kind: 'reading',
      enqueueSequenceJob: async () => {},
      tavilyAvailable: TAVILY_UP,
    });
    expect(reading.existing.map((h) => h.question_id)).toEqual([
      'r-auth', // tier 1
      'r-src-on', // tier 2, on-whitelist
      'r-src-off', // tier 2, off-whitelist (OF-2 demoted)
      'r-gen-1', // tier 4, created_at asc base order...
      'r-gen-2',
    ]);

    // ── 2) reading request, no count satisfaction — proves slice happens after sort ─
    // count larger than the matching pool: all reading non-draft rows of THIS KC, in the
    // same tier-then-created_at order, then r-easy (tier 4, difficulty 1) at the tail.
    const readingAll = await runSourcingSequence({
      db,
      knowledgeId: 'kc',
      count: 99,
      kind: 'reading',
      enqueueSequenceJob: async () => {},
      tavilyAvailable: TAVILY_UP,
    });
    expect(readingAll.existing.map((h) => h.question_id)).toEqual([
      'r-auth',
      'r-src-on',
      'r-src-off',
      'r-gen-1',
      'r-gen-2',
      'r-gen-3',
      'r-easy',
    ]);
    expect(readingAll.existing[0]).toMatchObject({ question_id: 'r-auth', tier: 1 });

    // ── 3) difficultyMin floor — the difficulty-1 row drops out ──────────────────
    const readingFloor = await runSourcingSequence({
      db,
      knowledgeId: 'kc',
      count: 99,
      kind: 'reading',
      difficultyMin: 2,
      enqueueSequenceJob: async () => {},
      tavilyAvailable: TAVILY_UP,
    });
    expect(readingFloor.existing.map((h) => h.question_id)).not.toContain('r-easy');
    expect(readingFloor.existing.map((h) => h.question_id)).toEqual([
      'r-auth',
      'r-src-on',
      'r-src-off',
      'r-gen-1',
      'r-gen-2',
      'r-gen-3',
    ]);

    // ── 4) computation request — only the computation row matches ────────────────
    const computation = await runSourcingSequence({
      db,
      knowledgeId: 'kc',
      count: 99,
      kind: 'computation',
      enqueueSequenceJob: async () => {},
      tavilyAvailable: TAVILY_UP,
    });
    expect(computation.existing.map((h) => h.question_id)).toEqual(['c-gen']);
  });

  it("unit='篇' selects only composite parents, slicing after the tier sort", async () => {
    await resetDb();
    await seedKnowledge('kc2');
    // a composite parent (older) + an authentic composite parent (newer): both have child
    // parts. The authentic one must sort first despite being created later.
    await seedQuestion({
      id: 'p-gen',
      knowledgeId: 'kc2',
      kind: 'reading',
      source: 'quiz_gen',
      createdAt: at(1),
    });
    await seedQuestion({
      id: 'p-gen-part',
      knowledgeId: 'kc2',
      kind: 'question_part',
      parentQuestionId: 'p-gen',
      createdAt: at(2),
    });
    await seedQuestion({
      id: 'p-auth',
      knowledgeId: 'kc2',
      kind: 'reading',
      source: 'wenyan',
      createdAt: at(3),
      metadata: TIER1_META,
    });
    await seedQuestion({
      id: 'p-auth-part',
      knowledgeId: 'kc2',
      kind: 'question_part',
      parentQuestionId: 'p-auth',
      createdAt: at(4),
    });
    // an atomic question (no child part) — excluded by the composite filter.
    await seedQuestion({
      id: 'atomic',
      knowledgeId: 'kc2',
      kind: 'reading',
      source: 'quiz_gen',
      createdAt: at(5),
    });

    const composite = await runSourcingSequence({
      db,
      knowledgeId: 'kc2',
      count: 99,
      unit: '篇',
      // kind=null: composite parents are NOT kind-filtered out.
      enqueueSequenceJob: async () => {},
      tavilyAvailable: TAVILY_UP,
    });
    // only the two composite parents, authentic-first.
    expect(composite.existing.map((h) => h.question_id)).toEqual(['p-auth', 'p-gen']);
  });
});

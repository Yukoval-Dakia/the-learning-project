// YUK-226 S2 slice 5b — unified 找题次序 orchestration DB test.
//
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §3.2
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §6.1 (5b.2).
//
// Asserts the §3.2 B+ 找题次序 + B2 同步/异步边界:
//   - step 1 命中 (existing pool ≥ count) → return immediately, enqueue NOTHING.
//   - step 1 不足 → enqueue background production in default 次序 (sourcing →
//     quiz_gen → quiz_gen) + return needs[] markers, WITHOUT waiting for ingest.
//   - existing-pool hits are ordered high tier first (deriveSourceTier).
//   - drafts never count toward step 1 (Gate-B precedent).
//   - profile route preference is honoured when present; defaults when absent
//     (S2-4 not yet merged — 容错 form).
//   - the default enqueue maps steps onto the right pg-boss queues.

import { describe, expect, it, vi } from 'vitest';

import { knowledge, question } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  DEFAULT_SOURCING_ROUTE,
  type EnqueueSequenceJobFn,
  type SourcingSequenceStep,
  resolveRoutePreference,
  runSourcingSequence,
} from './sourcing-sequence';

const db = testDb();

async function seedKnowledge(id: string) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: '之',
    domain: 'wenyan',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(opts: {
  id: string;
  knowledgeId: string;
  draft?: boolean;
  source?: string;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date();
  await db.insert(question).values({
    id: opts.id,
    kind: 'short_answer',
    prompt_md: `题目 ${opts.id}`,
    reference_md: '参考',
    rubric_json: { required_points: ['p'] } as never,
    choices_md: null,
    judge_kind_override: 'semantic',
    knowledge_ids: [opts.knowledgeId],
    difficulty: 3,
    source: opts.source ?? 'test',
    source_ref: opts.knowledgeId,
    draft_status: opts.draft ? 'draft' : null,
    created_by: { by: 'ai', task_kind: 'QuizGenTask', task_run_id: 'tr' } as never,
    metadata: (opts.metadata ?? {}) as never,
    created_at: now,
    updated_at: now,
  });
}

// A tier-1 authentic row (ingestion provenance) and a tier-4 generated row, so the
// high-tier-first ordering is observable.
const TIER1_META = { ingestion_session_id: 'sess-1' };

function collectingEnqueue(): {
  fn: EnqueueSequenceJobFn;
  calls: Array<{ step: SourcingSequenceStep; ref_id: string; count?: number; trigger: string }>;
} {
  const calls: Array<{
    step: SourcingSequenceStep;
    ref_id: string;
    count?: number;
    trigger: string;
  }> = [];
  const fn = vi.fn(async (step, data) => {
    calls.push({ step, ref_id: data.ref_id, count: data.count, trigger: data.trigger });
  });
  return { fn, calls };
}

describe('resolveRoutePreference (unit-shaped, no DB)', () => {
  const profile = resolveSubjectProfile('wenyan');

  it('returns the default 次序 when the profile declares no preference (S2-4 absent)', () => {
    expect(resolveRoutePreference(profile, 'short_answer')).toEqual(DEFAULT_SOURCING_ROUTE);
    expect(resolveRoutePreference(profile, null)).toEqual(DEFAULT_SOURCING_ROUTE);
  });

  it('honours a per-题型 preference when present, falling back to * then default', () => {
    const withPref = {
      ...profile,
      sourcingRoutePreference: {
        reading_comprehension: ['material_grounded', 'external_sourcing', 'closed_book'],
        '*': ['closed_book'],
      },
    } as never;
    // per-题型 match
    expect(resolveRoutePreference(withPref, 'reading_comprehension')).toEqual([
      'material_grounded',
      'external_sourcing',
      'closed_book',
    ]);
    // '*' fallback for an unlisted 题型
    expect(resolveRoutePreference(withPref, 'short_answer')).toEqual(['closed_book']);
  });

  it('ignores a malformed preference and falls back to default', () => {
    const bad = { ...profile, sourcingRoutePreference: { short_answer: ['nonsense'] } } as never;
    expect(resolveRoutePreference(bad, 'short_answer')).toEqual(DEFAULT_SOURCING_ROUTE);
  });
});

describe('runSourcingSequence', () => {
  it('step 1 命中: returns pool hits immediately and enqueues NOTHING', async () => {
    await resetDb();
    await seedKnowledge('k1');
    await seedQuestion({ id: 'q1', knowledgeId: 'k1' });
    await seedQuestion({ id: 'q2', knowledgeId: 'k1' });
    await seedQuestion({ id: 'q3', knowledgeId: 'k1' });

    const { fn, calls } = collectingEnqueue();
    const res = await runSourcingSequence({
      db,
      knowledgeId: 'k1',
      count: 3,
      enqueueSequenceJob: fn,
    });

    expect(res.satisfiedFromPool).toBe(true);
    expect(res.existing).toHaveLength(3);
    expect(res.enqueued).toEqual([]);
    expect(res.needs).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('orders existing-pool hits high tier first (authentic before generated)', async () => {
    await resetDb();
    await seedKnowledge('k1');
    // insert generated first, authentic second — tier order must win over insert order.
    await seedQuestion({ id: 'gen', knowledgeId: 'k1', source: 'quiz_gen' });
    await seedQuestion({ id: 'auth', knowledgeId: 'k1', source: 'wenyan', metadata: TIER1_META });

    const { fn } = collectingEnqueue();
    const res = await runSourcingSequence({
      db,
      knowledgeId: 'k1',
      count: 5, // force "insufficient" so we still get all hits back
      enqueueSequenceJob: fn,
    });

    expect(res.existing[0]).toMatchObject({ question_id: 'auth', tier: 1 });
    expect(res.existing[1]).toMatchObject({ question_id: 'gen', tier: 4 });
  });

  it('drafts never count toward step 1 (Gate-B precedent)', async () => {
    await resetDb();
    await seedKnowledge('k1');
    await seedQuestion({ id: 'draft1', knowledgeId: 'k1', draft: true });
    await seedQuestion({ id: 'draft2', knowledgeId: 'k1', draft: true });

    const { fn, calls } = collectingEnqueue();
    const res = await runSourcingSequence({
      db,
      knowledgeId: 'k1',
      count: 1,
      enqueueSequenceJob: fn,
    });

    expect(res.existing).toHaveLength(0);
    expect(res.satisfiedFromPool).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('step 1 不足: enqueues background production in default 次序 + returns needs[]', async () => {
    await resetDb();
    await seedKnowledge('k1');
    await seedQuestion({ id: 'q1', knowledgeId: 'k1' });

    const { fn, calls } = collectingEnqueue();
    const res = await runSourcingSequence({
      db,
      knowledgeId: 'k1',
      count: 3,
      enqueueSequenceJob: fn,
    });

    expect(res.satisfiedFromPool).toBe(false);
    expect(res.existing).toHaveLength(1); // the one hit组卷 can use now
    // default 次序: external_sourcing → material_grounded → closed_book
    expect(res.enqueued).toEqual(['external_sourcing', 'material_grounded', 'closed_book']);
    expect(calls.map((c) => c.step)).toEqual([
      'external_sourcing',
      'material_grounded',
      'closed_book',
    ]);
    // every enqueued job carries the trigger + ref_id + count.
    for (const c of calls) {
      expect(c.trigger).toBe('knowledge');
      expect(c.ref_id).toBe('k1');
      expect(c.count).toBe(3);
    }
    // needs[] mirror the question_generation 先例 + additive source discriminator.
    expect(res.needs).toHaveLength(3);
    expect(res.needs.map((n) => n.source)).toEqual([
      'external_sourcing',
      'material_grounded',
      'closed_book',
    ]);
    for (const n of res.needs) {
      expect(n.kind).toBe('question_generation');
      expect(n.knowledge_id).toBe('k1');
    }
  });

  it('forwards ref_id / trigger overrides to enqueued jobs', async () => {
    await resetDb();
    await seedKnowledge('k1');

    const { fn, calls } = collectingEnqueue();
    await runSourcingSequence({
      db,
      knowledgeId: 'k1',
      refId: 'li-99',
      trigger: 'learning_item',
      count: 2,
      enqueueSequenceJob: fn,
    });

    for (const c of calls) {
      expect(c.ref_id).toBe('li-99');
      expect(c.trigger).toBe('learning_item');
    }
  });
});

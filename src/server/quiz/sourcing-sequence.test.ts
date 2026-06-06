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
import * as profileModule from '@/subjects/profile';
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

// A tier-2 web_sourced row. whitelist_match drives the OF-2 within-tier demotion.
function tier2Meta(whitelistMatch: boolean): Record<string, unknown> {
  return {
    source_ref_kind: 'url',
    web_sourced: {
      url: 'https://example.com/q',
      title: 't',
      fetched_at: '2026-06-06T00:00:00Z',
      whitelist_match: whitelistMatch,
      // extract is REQUIRED by WebSourcedProvenance (provenance.ts:63) or the row
      // falls through to tier 4 and the demotion ordering can't be observed.
      extract: '示例题干抽取',
    },
  };
}

interface EnqueueCall {
  step: SourcingSequenceStep;
  ref_id: string;
  count?: number;
  trigger: string;
  generation_method?: 'material_grounded' | 'closed_book';
  knowledge_id?: string;
  kind?: string;
}

function collectingEnqueue(): {
  fn: EnqueueSequenceJobFn;
  calls: EnqueueCall[];
} {
  const calls: EnqueueCall[] = [];
  const fn = vi.fn(async (step, data) => {
    calls.push({
      step,
      ref_id: data.ref_id,
      count: data.count,
      trigger: data.trigger,
      generation_method: data.generation_method,
      knowledge_id: data.knowledge_id,
      kind: data.kind,
    });
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

  // F1 (PR #318 round-1) — the quiz_gen steps carry an EXPLICIT generation_method so
  // the worker executes the tier the次序 asked for (step 3 material vs step 4 closed).
  it('pins generation_method per quiz_gen step (material_grounded / closed_book)', async () => {
    await resetDb();
    await seedKnowledge('k1');

    const { fn, calls } = collectingEnqueue();
    await runSourcingSequence({ db, knowledgeId: 'k1', count: 3, enqueueSequenceJob: fn });

    const byStep = new Map(calls.map((c) => [c.step, c]));
    // external_sourcing rides the sourcing queue — NO method axis.
    expect(byStep.get('external_sourcing')?.generation_method).toBeUndefined();
    // step 3 → material_grounded (tier 3); step 4 → closed_book (tier 4).
    expect(byStep.get('material_grounded')?.generation_method).toBe('material_grounded');
    expect(byStep.get('closed_book')?.generation_method).toBe('closed_book');
  });

  // F3 (PR #318 round-1) — manual trigger with a free-form ref_id still keys produced
  // questions to the knowledge node (knowledge_id forwarded on every enqueued job).
  it('forwards knowledge_id for attribution under a manual free-form ref', async () => {
    await resetDb();
    await seedKnowledge('k1');

    const { fn, calls } = collectingEnqueue();
    await runSourcingSequence({
      db,
      knowledgeId: 'k1',
      refId: 'free form manual ref',
      trigger: 'manual',
      count: 3,
      enqueueSequenceJob: fn,
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // ref_id stays the free-form trigger pointer; knowledge_id is the attribution anchor.
      expect(c.ref_id).toBe('free form manual ref');
      expect(c.knowledge_id).toBe('k1');
    }
  });

  // F4 (PR #318 round-4) — the 题型 hint that selected the route is forwarded on every
  // enqueued job (sourcing→kinds, quiz_gen→kind) so the produced job can target the题型.
  it('forwards the kind hint to every enqueued job when provided', async () => {
    await resetDb();
    await seedKnowledge('k1');

    const { fn, calls } = collectingEnqueue();
    await runSourcingSequence({
      db,
      knowledgeId: 'k1',
      count: 3,
      kind: 'reading',
      enqueueSequenceJob: fn,
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.kind).toBe('reading');
    }
  });

  it('omits the kind hint on enqueued jobs when none is passed', async () => {
    await resetDb();
    await seedKnowledge('k1');

    const { fn, calls } = collectingEnqueue();
    await runSourcingSequence({ db, knowledgeId: 'k1', count: 3, enqueueSequenceJob: fn });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.kind).toBeUndefined();
    }
  });

  // F2 (PR #318 round-1) — when many OLD low-tier rows exceed limit×4, a NEW high-tier
  // row created LAST must still be selected. The previous SQL截断 (limit×4 by created_at)
  // dropped it before the tier sort; fetching the full candidate set fixes it.
  it('selects a new high-tier row even when old low-tier rows exceed limit×4', async () => {
    await resetDb();
    await seedKnowledge('k1');
    const limit = 2;
    // Seed limit×4 + a margin of OLD tier-4 generated rows FIRST (earliest created_at).
    for (let i = 0; i < limit * 4 + 3; i++) {
      await seedQuestion({ id: `gen-${i}`, knowledgeId: 'k1', source: 'quiz_gen' });
    }
    // Then a NEW tier-1 authentic row (latest created_at — last in the SQL截断 window).
    await seedQuestion({
      id: 'auth-new',
      knowledgeId: 'k1',
      source: 'wenyan',
      metadata: TIER1_META,
    });

    const { fn } = collectingEnqueue();
    const res = await runSourcingSequence({
      db,
      knowledgeId: 'k1',
      count: limit,
      enqueueSequenceJob: fn,
    });

    // The new high-tier authentic row must be the FIRST hit despite being created last.
    expect(res.existing[0]).toMatchObject({ question_id: 'auth-new', tier: 1 });
  });

  // F4 (PR #318 round-1) — within the SAME tier, off-whitelist (whitelist_match=false)
  // sorts BEHIND on-whitelist (reuses the slice 5a comparator — 合约五).
  it('demotes off-whitelist tier-2 rows behind on-whitelist within the pool', async () => {
    await resetDb();
    await seedKnowledge('k1');
    // insert off-whitelist FIRST (earlier created_at) so only the tier+demotion order,
    // not insertion order, can put on-whitelist ahead.
    await seedQuestion({
      id: 'q_off',
      knowledgeId: 'k1',
      source: 'web_sourced',
      metadata: tier2Meta(false),
    });
    await seedQuestion({
      id: 'q_on',
      knowledgeId: 'k1',
      source: 'web_sourced',
      metadata: tier2Meta(true),
    });

    const { fn } = collectingEnqueue();
    const res = await runSourcingSequence({
      db,
      knowledgeId: 'k1',
      count: 5, // force insufficient so both hits come back
      enqueueSequenceJob: fn,
    });

    const ids = res.existing.map((h) => h.question_id);
    expect(res.existing.every((h) => h.tier === 2)).toBe(true);
    expect(ids.indexOf('q_on')).toBeLessThan(ids.indexOf('q_off'));
  });

  // F5 (PR #318 round-1) — when domain is omitted, the profile route is resolved from
  // the KNOWLEDGE NODE's own domain, not the default subject. Proven by asserting the
  // domain ACTUALLY passed to resolveSubjectProfile equals the node's domain (the route
  // step list is identical across subjects until S2-4, so the observable proof is the
  // resolution INPUT, not the output route).
  it('resolves the subject profile from the knowledge node domain when domain omitted', async () => {
    await resetDb();
    await seedKnowledge('k_math', 'math');

    const spy = vi.spyOn(profileModule, 'resolveSubjectProfile');
    try {
      const { fn } = collectingEnqueue();
      await runSourcingSequence({
        db,
        knowledgeId: 'k_math',
        count: 3, // force insufficient (empty pool) so the profile path runs
        // NO domain passed → must derive from the node.
        enqueueSequenceJob: fn,
      });
      // The orchestrator resolved the profile off the node's domain ('math'), NOT the
      // default-subject fallback (null).
      expect(spy).toHaveBeenCalledWith('math');
      expect(spy).not.toHaveBeenCalledWith(null);
    } finally {
      spy.mockRestore();
    }
  });
});

// YUK-225 (S2 slice 4) — few-shot retriever DB test.
//
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §5.3.
//
// Asserts the 轨 2 SQL retriever: same-kind + pool predicate
// `(draft_status IS NULL OR <> 'draft')`, knowledge-overlap candidate pull, SQL-layer
// tier-priority ordering before truncation + TS-layer tier sort, LIMIT, 0-hit 降级.

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { question } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { retrieveFewShotExamples } from './fewshot-retrieve';

interface SeedOpts {
  kind?: string;
  knowledgeIds?: string[];
  source?: string;
  metadata?: Record<string, unknown> | null;
  draftStatus?: string | null;
  createdAt?: Date;
}

async function seed(opts: SeedOpts = {}): Promise<string> {
  const db = testDb();
  const id = createId();
  const now = opts.createdAt ?? new Date();
  await db.insert(question).values({
    id,
    kind: opts.kind ?? 'translation',
    prompt_md: `题面 ${id}`,
    reference_md: '参考答案',
    rubric_json: null,
    choices_md: null,
    judge_kind_override: 'semantic',
    knowledge_ids: opts.knowledgeIds ?? ['k1'],
    difficulty: 3,
    source: opts.source ?? 'quiz_gen',
    source_ref: null,
    draft_status: opts.draftStatus === undefined ? 'active' : opts.draftStatus,
    created_by: { by: 'ai', task_kind: 'QuizGenTask' },
    metadata: (opts.metadata ?? {}) as never,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

const ingestionMeta = { ingestion_session_id: 'sess-1' }; // → tier 1
const generatedMeta = {}; // quiz_gen, no provenance → tier 4

describe('retrieveFewShotExamples', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('降级: 0 hits → empty array', async () => {
    const db = testDb();
    const out = await retrieveFewShotExamples({ db, kind: 'translation', knowledgeIds: ['k1'] });
    expect(out).toEqual([]);
  });

  it('filters by kind and active status (drafts excluded)', async () => {
    const db = testDb();
    await seed({ kind: 'translation', knowledgeIds: ['k1'] });
    await seed({ kind: 'calculation', knowledgeIds: ['k1'] }); // wrong kind
    await seed({ kind: 'translation', knowledgeIds: ['k1'], draftStatus: 'draft' }); // draft

    const out = await retrieveFewShotExamples({ db, kind: 'translation', knowledgeIds: ['k1'] });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('translation');
  });

  it('ranks higher tier first (tier 1 authentic before tier 4 generated)', async () => {
    const db = testDb();
    const generatedId = await seed({ knowledgeIds: ['k1'], metadata: generatedMeta });
    const ingestedId = await seed({
      knowledgeIds: ['k1'],
      source: 'vision_paper',
      metadata: ingestionMeta,
    });

    const out = await retrieveFewShotExamples({ db, kind: 'translation', knowledgeIds: ['k1'] });
    expect(out.map((e) => e.id)).toEqual([ingestedId, generatedId]);
    expect(out[0].tier).toBe(1);
    expect(out[1].tier).toBe(4);
  });

  it('within a tier, ranks by knowledge overlap', async () => {
    const db = testDb();
    const lowOverlap = await seed({ knowledgeIds: ['k1'] });
    const highOverlap = await seed({ knowledgeIds: ['k1', 'k2'] });

    const out = await retrieveFewShotExamples({
      db,
      kind: 'translation',
      knowledgeIds: ['k1', 'k2'],
    });
    expect(out[0].id).toBe(highOverlap);
    expect(out[1].id).toBe(lowOverlap);
  });

  it('respects the limit', async () => {
    const db = testDb();
    for (let i = 0; i < 5; i++) await seed({ knowledgeIds: ['k1'] });
    const out = await retrieveFewShotExamples({
      db,
      kind: 'translation',
      knowledgeIds: ['k1'],
      limit: 2,
    });
    expect(out).toHaveLength(2);
  });

  it('with empty knowledgeIds, falls back to recent active same-kind questions', async () => {
    const db = testDb();
    await seed({ knowledgeIds: ['kX'] });
    const out = await retrieveFewShotExamples({ db, kind: 'translation', knowledgeIds: [] });
    expect(out).toHaveLength(1);
  });

  // PR #319 F4 — legacy active rows carry NULL draft_status; a bare `= 'active'`
  // predicate dropped them. The pool predicate is now
  // `(draft_status IS NULL OR <> 'draft')` (aligns with due-list / source_verify), so
  // a NULL-draft_status row is eligible while a 'draft' row stays excluded.
  it('includes legacy NULL draft_status rows (excludes drafts)', async () => {
    const db = testDb();
    const nullDraft = await seed({ knowledgeIds: ['k1'], draftStatus: null });
    await seed({ knowledgeIds: ['k1'], draftStatus: 'draft' }); // still excluded
    const out = await retrieveFewShotExamples({ db, kind: 'translation', knowledgeIds: ['k1'] });
    expect(out.map((e) => e.id)).toEqual([nullDraft]);
  });

  // PR #319 F5 — tier ordering must happen in SQL BEFORE the CANDIDATE_POOL (20)
  // truncation. A high-tier exemplar OLDER than a flood of recent low-tier rows must
  // still be pulled into the pool (and then surfaced by the TS tier sort). With a pure
  // `ORDER BY created_at DESC LIMIT 20`, the 25 newer tier-4 rows would evict the older
  // tier-1 row from the pool entirely.
  it('surfaces an older high-tier row past a recency flood of low-tier rows', async () => {
    const db = testDb();
    const base = Date.now();
    // 25 recent tier-4 (generated) rows — newer than the tier-1 exemplar, and more
    // numerous than CANDIDATE_POOL (20), so recency-only truncation would bury tier 1.
    for (let i = 0; i < 25; i++) {
      await seed({
        knowledgeIds: ['k1'],
        metadata: generatedMeta,
        createdAt: new Date(base + 1000 + i),
      });
    }
    // One OLDER tier-1 (ingested authentic) exemplar.
    const ingestedId = await seed({
      knowledgeIds: ['k1'],
      source: 'vision_paper',
      metadata: ingestionMeta,
      createdAt: new Date(base),
    });

    const out = await retrieveFewShotExamples({
      db,
      kind: 'translation',
      knowledgeIds: ['k1'],
      limit: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(ingestedId);
    expect(out[0].tier).toBe(1);
  });
});

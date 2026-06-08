// YUK-280 P4 (YUK-203) — loadQuestionDetail DB integration test.
//
// Covers A1d aggregate (row + source_tier + labels + family + scheduling +
// timeline) and A1e (per-knowledge decay aggregate + 题级 backlinks).

import { newId } from '@/core/ids';
import { artifact, event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { loadQuestionDetail } from '@/server/questions/detail';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

const NOW = new Date('2026-06-07T00:00:00Z');

async function seedKnowledge(id: string, opts: { archived?: boolean; name?: string } = {}) {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: opts.name ?? `node ${id}`,
      domain: 'wenyan',
      archived_at: opts.archived ? NOW : null,
      created_at: NOW,
      updated_at: NOW,
    });
}

async function seedQuestion(opts: {
  id?: string;
  kind?: string;
  source?: string;
  prompt_md?: string;
  knowledge_ids?: string[];
  variant_depth?: number;
  root_question_id?: string | null;
  parent_question_id?: string | null;
  part_index?: number | null;
  metadata?: Record<string, unknown> | null;
  draft_status?: string | null;
  created_at?: Date;
}): Promise<string> {
  const id = opts.id ?? newId();
  const at = opts.created_at ?? NOW;
  await testDb()
    .insert(question)
    .values({
      id,
      kind: opts.kind ?? 'reading',
      prompt_md: opts.prompt_md ?? 'p'.repeat(10),
      reference_md: 'ref',
      knowledge_ids: opts.knowledge_ids ?? [],
      difficulty: 3,
      source: opts.source ?? 'manual',
      variant_depth: opts.variant_depth ?? 0,
      root_question_id: opts.root_question_id ?? null,
      parent_question_id: opts.parent_question_id ?? null,
      part_index: opts.part_index ?? null,
      draft_status: opts.draft_status ?? null,
      metadata: (opts.metadata ?? null) as never,
      created_at: at,
      updated_at: at,
    });
  return id;
}

async function seedAttempt(opts: {
  question_id: string;
  knowledge_id: string;
  outcome?: 'success' | 'failure';
  created_at?: Date;
}): Promise<string> {
  const id = newId();
  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: opts.question_id,
      outcome: opts.outcome ?? 'failure',
      payload: {
        answer_md: 'a',
        answer_image_refs: [],
        referenced_knowledge_ids: [opts.knowledge_id],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: opts.created_at ?? NOW,
    });
  return id;
}

function makeFsrsState(due: Date) {
  return {
    due: due.toISOString(),
    stability: 1.5,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 'review',
    last_review: null,
  };
}

async function seedFsrs(subjectKind: 'knowledge' | 'question', subjectId: string, dueAt: Date) {
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: `f_${subjectKind}_${subjectId}`,
      subject_kind: subjectKind,
      subject_id: subjectId,
      state: makeFsrsState(dueAt) as never,
      due_at: dueAt,
      last_review_event_id: null,
      updated_at: NOW,
    });
}

async function seedArtifact(opts: {
  id?: string;
  type?: string;
  title?: string;
  tool_kind?: string | null;
  intent_source: string;
  question_ids: string[];
  archived?: boolean;
  generation_status?: string;
  created_at?: Date;
}): Promise<string> {
  const id = opts.id ?? newId();
  const at = opts.created_at ?? NOW;
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: opts.type ?? 'tool_quiz',
      title: opts.title ?? 'paper',
      knowledge_ids: [],
      intent_source: opts.intent_source,
      source: 'ai_generated',
      tool_kind: opts.tool_kind ?? null,
      tool_state: { question_ids: opts.question_ids } as never,
      generation_status: opts.generation_status ?? 'ready',
      archived_at: opts.archived ? at : null,
      created_at: at,
      updated_at: at,
    });
  return id;
}

describe('loadQuestionDetail', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null for a missing question', async () => {
    const res = await loadQuestionDetail(testDb(), 'q_nope');
    expect(res).toBeNull();
  });

  it('aggregates row + source_tier + labels (archived label dropped)', async () => {
    const k1 = newId();
    const kArchived = newId();
    await seedKnowledge(k1, { name: 'alpha' });
    await seedKnowledge(kArchived, { archived: true, name: 'gone' });
    const qid = await seedQuestion({
      source: 'vision_paper',
      metadata: { ingestion_session_id: 'sess_x' },
      knowledge_ids: [k1, kArchived],
    });

    const res = await loadQuestionDetail(testDb(), qid);
    expect(res).not.toBeNull();
    expect(res?.source_tier).toEqual({ tier: 1, name: 'authentic' });
    // archived knowledge dropped from labels; k1 kept.
    expect(res?.labels.map((l) => l.id)).toEqual([k1]);
    expect(res?.knowledge_ids).toEqual([k1, kArchived]);
  });

  it('returns the variant family with is_self marked', async () => {
    const root = await seedQuestion({ variant_depth: 0, root_question_id: null });
    const v1 = await seedQuestion({ variant_depth: 1, root_question_id: root });
    const v2 = await seedQuestion({ variant_depth: 2, root_question_id: root });

    const res = await loadQuestionDetail(testDb(), v1);
    expect(res?.family.root_question_id).toBe(root);
    expect(res?.family.variant_count).toBe(3);
    const self = res?.family.members.find((m) => m.is_self);
    expect(self?.id).toBe(v1);
    expect(new Set(res?.family.members.map((m) => m.id))).toEqual(new Set([root, v1, v2]));
  });

  it('aggregates per-knowledge scheduling + worst-of decay bucket', async () => {
    const kFresh = newId();
    const kStale = newId();
    await seedKnowledge(kFresh);
    await seedKnowledge(kStale);
    const qid = await seedQuestion({ knowledge_ids: [kFresh, kStale] });

    // fresh evidence (today) for kFresh; stale evidence (>30d ago) for kStale.
    await seedAttempt({ question_id: qid, knowledge_id: kFresh, created_at: new Date() });
    await seedAttempt({
      question_id: qid,
      knowledge_id: kStale,
      created_at: new Date(Date.now() - 40 * 86_400_000),
    });
    await seedFsrs('knowledge', kFresh, new Date('2026-07-01T00:00:00Z'));

    const res = await loadQuestionDetail(testDb(), qid);
    const sched = res?.scheduling;
    expect(sched?.per_knowledge).toHaveLength(2);
    const fresh = sched?.per_knowledge.find((p) => p.knowledge_id === kFresh);
    const stale = sched?.per_knowledge.find((p) => p.knowledge_id === kStale);
    expect(fresh?.decay_bucket).toBe('fresh');
    expect(fresh?.due_at_sec).toBeGreaterThan(0);
    expect(stale?.decay_bucket).toBe('stale');
    // worst-of aggregate = stale.
    expect(sched?.aggregate_decay_bucket).toBe('stale');
    expect(sched?.legacy_question_fsrs).toBeNull();
  });

  it('falls back to legacy per-question FSRS for unlabeled questions', async () => {
    const qid = await seedQuestion({ knowledge_ids: [] });
    await seedFsrs('question', qid, new Date('2026-08-01T00:00:00Z'));

    const res = await loadQuestionDetail(testDb(), qid);
    expect(res?.scheduling.per_knowledge).toEqual([]);
    expect(res?.scheduling.aggregate_decay_bucket).toBe('unknown');
    expect(res?.scheduling.legacy_question_fsrs?.due_at_sec).toBeGreaterThan(0);
  });

  it('lists 题级 backlinks grouped by intent_source, archived dropped', async () => {
    const qid = await seedQuestion({ knowledge_ids: [] });
    await seedArtifact({ intent_source: 'quiz_gen', question_ids: [qid] });
    await seedArtifact({
      intent_source: 'embedded_check',
      tool_kind: 'embedded_check',
      question_ids: [qid],
    });
    await seedArtifact({ intent_source: 'ingestion_paper', question_ids: [qid] });
    // archived reference → dropped.
    await seedArtifact({ intent_source: 'quiz_gen', question_ids: [qid], archived: true });
    // unrelated artifact → not matched.
    await seedArtifact({ intent_source: 'quiz_gen', question_ids: [newId()] });

    const res = await loadQuestionDetail(testDb(), qid);
    expect(res?.backlinks).toHaveLength(3);
    const groups = res?.backlinks_by_intent_source ?? {};
    expect(groups.quiz_gen).toHaveLength(1); // archived one excluded
    expect(groups.embedded_check).toHaveLength(1);
    expect(groups.ingestion_paper).toHaveLength(1);
  });

  it('returns empty backlinks when nothing references the question', async () => {
    const qid = await seedQuestion({ knowledge_ids: [] });
    const res = await loadQuestionDetail(testDb(), qid);
    expect(res?.backlinks).toEqual([]);
    expect(res?.backlinks_by_intent_source).toEqual({});
  });

  it('hydrates the event timeline via getQuestionTimeline', async () => {
    const k1 = newId();
    await seedKnowledge(k1);
    const qid = await seedQuestion({ knowledge_ids: [k1] });
    await seedAttempt({ question_id: qid, knowledge_id: k1, outcome: 'failure' });

    const res = await loadQuestionDetail(testDb(), qid);
    expect(res?.timeline.length).toBeGreaterThanOrEqual(1);
    const attempt = res?.timeline.find((t) => t.kind === 'attempt');
    expect(attempt?.outcome).toBe('failure');
    expect(Number.isInteger(attempt?.created_at_sec)).toBe(true);
  });

  it('shows a draft question (detail does not exclude drafts)', async () => {
    const qid = await seedQuestion({ knowledge_ids: [], draft_status: 'draft' });
    const res = await loadQuestionDetail(testDb(), qid);
    expect(res?.draft_status).toBe('draft');
    expect(res?.id).toBe(qid);
  });

  it('returns ordered composite parts for a parent (YUK-288 gap A)', async () => {
    const parent = await seedQuestion({ knowledge_ids: [], kind: 'reading' });
    // seed parts out of part_index order so we assert the ORDER BY part_index.
    await seedQuestion({
      parent_question_id: parent,
      part_index: 1,
      kind: 'short',
      prompt_md: 'part two',
      draft_status: 'draft',
    });
    await seedQuestion({
      parent_question_id: parent,
      part_index: 0,
      kind: 'mcq',
      prompt_md: 'part one',
    });

    const res = await loadQuestionDetail(testDb(), parent);
    expect(res?.parts.map((p) => p.part_index)).toEqual([0, 1]);
    expect(res?.parts.map((p) => p.prompt_md)).toEqual(['part one', 'part two']);
    expect(res?.parts[0].kind).toBe('mcq');
    // drafts are NOT excluded from the parts list (detail shows drafts).
    expect(res?.parts[1].draft_status).toBe('draft');
    // the parent itself is top-level (no parent linkage).
    expect(res?.parent_question_id).toBeNull();
    expect(res?.part_index).toBeNull();
  });

  it('carries parent_question_id on a part so the UI can render the breadcrumb', async () => {
    const parent = await seedQuestion({ knowledge_ids: [] });
    const part = await seedQuestion({
      parent_question_id: parent,
      part_index: 0,
      kind: 'mcq',
    });

    const res = await loadQuestionDetail(testDb(), part);
    expect(res?.parent_question_id).toBe(parent);
    expect(res?.part_index).toBe(0);
    // a leaf part has no parts of its own.
    expect(res?.parts).toEqual([]);
  });

  it('returns empty parts for an ordinary (non-composite) question', async () => {
    const qid = await seedQuestion({ knowledge_ids: [] });
    const res = await loadQuestionDetail(testDb(), qid);
    expect(res?.parts).toEqual([]);
  });
});

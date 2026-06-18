// YUK-402 inc-4a — owner manual gate: draft-review list projection DB test.
//
// listDraftReview lists draft_status='draft' questions (excluding soft-archived
// drafts, which carry metadata.archived_at), projecting a review row + a verify
// status derived from the latest TERMINAL verify event (experimental:quiz_verify /
// experimental:source_verify, outcome != 'error'):
//   - no terminal verify event        → 'unverified' (未验过)
//   - latest terminal, not promoted    → 'needs_review' | 'failed' (+ reason)
//
// db test seeds questions + verify events directly (no AI).

import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { event, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { getDraftReviewDetail, listDraftReview } from './draft-review';

async function seedKnowledge(
  id: string,
  name?: string,
  archivedAt: Date | null = null,
): Promise<string> {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: name ?? id,
      domain: 'wenyan',
      archived_at: archivedAt,
      created_at: new Date(),
      updated_at: new Date(),
    });
  return id;
}

async function seedQuestion(opts: {
  id?: string;
  source?: string;
  kind?: string;
  prompt_md?: string;
  reference_md?: string | null;
  choices_md?: string[] | null;
  difficulty?: number;
  knowledge_ids?: string[];
  structured?: unknown;
  draft_status?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: Date;
}): Promise<string> {
  const id = opts.id ?? newId();
  const now = opts.created_at ?? new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      kind: opts.kind ?? 'short_answer',
      prompt_md: opts.prompt_md ?? 'prompt',
      reference_md: opts.reference_md ?? null,
      choices_md: (opts.choices_md ?? null) as never,
      knowledge_ids: opts.knowledge_ids ?? [],
      difficulty: opts.difficulty ?? 3,
      structured: (opts.structured ?? null) as never,
      source: opts.source ?? 'quiz_gen',
      draft_status: opts.draft_status === undefined ? 'draft' : opts.draft_status,
      metadata: (opts.metadata ?? null) as never,
      created_at: now,
      updated_at: now,
    });
  return id;
}

async function seedVerifyEvent(opts: {
  questionId: string;
  action: 'experimental:quiz_verify' | 'experimental:source_verify';
  outcome: string;
  payload?: Record<string, unknown>;
  created_at?: Date;
}): Promise<void> {
  await writeEvent(testDb(), {
    id: newId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'quiz_verify',
    action: opts.action,
    subject_kind: 'question',
    subject_id: opts.questionId,
    outcome: opts.outcome,
    payload: { question_id: opts.questionId, ...(opts.payload ?? {}) },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
}

describe('listDraftReview', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('lists only draft_status=draft rows (excludes active + NULL)', async () => {
    const d = await seedQuestion({ draft_status: 'draft' });
    await seedQuestion({ draft_status: 'active' });
    await seedQuestion({ draft_status: null });

    const page = await listDraftReview(testDb(), {});
    expect(page.total).toBe(1);
    expect(page.rows.map((r) => r.id)).toEqual([d]);
  });

  it('excludes soft-archived drafts (metadata.archived_at set)', async () => {
    const live = await seedQuestion({ draft_status: 'draft' });
    await seedQuestion({
      draft_status: 'draft',
      metadata: { archived_at: Math.floor(Date.now() / 1000), archived_reason: 'deleted' },
    });

    const page = await listDraftReview(testDb(), {});
    expect(page.total).toBe(1);
    expect(page.rows.map((r) => r.id)).toEqual([live]);
  });

  it('derives verify status = unverified when no verify event exists', async () => {
    const q = await seedQuestion({ draft_status: 'draft' });
    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.verify_status).toBe('unverified');
    expect(row?.verify_reason).toBeNull();
  });

  it('derives needs_review from the latest terminal quiz_verify event + reason', async () => {
    const q = await seedQuestion({ source: 'quiz_gen', draft_status: 'draft' });
    await seedVerifyEvent({
      questionId: q,
      action: 'experimental:quiz_verify',
      outcome: 'partial',
      payload: {
        promoted: false,
        verification_status: 'needs_review',
        overall: 'needs_review',
        summary_md: '语义不够清晰',
      },
    });

    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.verify_status).toBe('needs_review');
    expect(row?.verify_reason).toBe('语义不够清晰');
  });

  it('derives failed from the latest terminal quiz_verify event', async () => {
    const q = await seedQuestion({ source: 'quiz_gen', draft_status: 'draft' });
    await seedVerifyEvent({
      questionId: q,
      action: 'experimental:quiz_verify',
      outcome: 'failure',
      payload: { promoted: false, verification_status: 'failed', overall: 'fail' },
    });

    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.verify_status).toBe('failed');
  });

  it('derives failed from a tier-2 source_verify failure (no verification_status field)', async () => {
    const q = await seedQuestion({ source: 'web_sourced', draft_status: 'draft' });
    await seedVerifyEvent({
      questionId: q,
      action: 'experimental:source_verify',
      outcome: 'failure',
      payload: { promoted: false, tier: 2 },
    });

    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.verify_status).toBe('failed');
  });

  it('ignores transient error verify events (outcome=error) → still unverified', async () => {
    const q = await seedQuestion({ source: 'quiz_gen', draft_status: 'draft' });
    await seedVerifyEvent({
      questionId: q,
      action: 'experimental:quiz_verify',
      outcome: 'error',
      payload: { overall: 'error', failure_class: 'system_error' },
    });

    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.verify_status).toBe('unverified');
  });

  it('uses the LATEST terminal verify event when several exist', async () => {
    const q = await seedQuestion({ source: 'quiz_gen', draft_status: 'draft' });
    await seedVerifyEvent({
      questionId: q,
      action: 'experimental:quiz_verify',
      outcome: 'failure',
      payload: { promoted: false, verification_status: 'failed' },
      created_at: new Date('2026-06-01T00:00:00Z'),
    });
    await seedVerifyEvent({
      questionId: q,
      action: 'experimental:quiz_verify',
      outcome: 'partial',
      payload: { promoted: false, verification_status: 'needs_review', summary_md: '复核' },
      created_at: new Date('2026-06-02T00:00:00Z'),
    });

    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.verify_status).toBe('needs_review');
    expect(row?.verify_reason).toBe('复核');
  });

  it('truncates the prompt preview', async () => {
    const long = 'x'.repeat(500);
    const q = await seedQuestion({ draft_status: 'draft', prompt_md: long });
    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.prompt_preview.length).toBeLessThan(long.length);
  });

  it('filters by source and kind', async () => {
    await seedQuestion({ draft_status: 'draft', source: 'quiz_gen', kind: 'short_answer' });
    await seedQuestion({ draft_status: 'draft', source: 'web_sourced', kind: 'short_answer' });
    await seedQuestion({ draft_status: 'draft', source: 'quiz_gen', kind: 'reading' });

    const bySource = await listDraftReview(testDb(), { source: 'quiz_gen' });
    expect(bySource.total).toBe(2);
    const byKind = await listDraftReview(testDb(), { kind: 'reading' });
    expect(byKind.total).toBe(1);
    const both = await listDraftReview(testDb(), { source: 'quiz_gen', kind: 'reading' });
    expect(both.total).toBe(1);
  });

  it('paginates with limit/offset + reports total + truncated', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedQuestion({
        draft_status: 'draft',
        created_at: new Date(2026, 5, 1 + i),
      });
    }
    const page = await listDraftReview(testDb(), { limit: 2, offset: 0 });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.truncated).toBe(true);

    const page2 = await listDraftReview(testDb(), { limit: 2, offset: 4 });
    expect(page2.rows).toHaveLength(1);
  });

  // inc-4b — list projection补 difficulty + knowledge labels (preview-pane meta).
  it('projects difficulty on each row', async () => {
    const q = await seedQuestion({ draft_status: 'draft', difficulty: 5 });
    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.difficulty).toBe(5);
  });

  it('resolves knowledge ids → {id,label} (batch, label = knowledge.name)', async () => {
    await seedKnowledge('k1', '宾语前置');
    await seedKnowledge('k2', '使动用法');
    const q = await seedQuestion({ draft_status: 'draft', knowledge_ids: ['k1', 'k2'] });

    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.knowledge).toEqual([
      { id: 'k1', label: '宾语前置' },
      { id: 'k2', label: '使动用法' },
    ]);
  });

  it('falls back to the id as label when a knowledge node is missing', async () => {
    const q = await seedQuestion({ draft_status: 'draft', knowledge_ids: ['ghost'] });
    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.knowledge).toEqual([{ id: 'ghost', label: 'ghost' }]);
  });

  it('projects an empty knowledge array when the question has no KCs', async () => {
    const q = await seedQuestion({ draft_status: 'draft', knowledge_ids: [] });
    const page = await listDraftReview(testDb(), {});
    const row = page.rows.find((r) => r.id === q);
    expect(row?.knowledge).toEqual([]);
  });
});

// ── inc-4b — getDraftReviewDetail (full-text draft preview projection) ─────────
describe('getDraftReviewDetail', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the full draft projection (prompt_md is NOT truncated)', async () => {
    await seedKnowledge('k1', '通假字');
    const longPrompt = 'y'.repeat(500);
    const q = await seedQuestion({
      draft_status: 'draft',
      kind: 'mcq',
      source: 'quiz_gen',
      prompt_md: longPrompt,
      reference_md: '答案是 B',
      choices_md: ['甲', '乙', '丙', '丁'],
      difficulty: 4,
      knowledge_ids: ['k1'],
    });

    const detail = await getDraftReviewDetail(testDb(), q);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(q);
    expect(detail?.kind).toBe('mcq');
    expect(detail?.source).toBe('quiz_gen');
    expect(detail?.difficulty).toBe(4);
    // full text, not the 160-char preview.
    expect(detail?.prompt_md).toBe(longPrompt);
    expect(detail?.options).toEqual(['甲', '乙', '丙', '丁']);
    expect(detail?.answer).toBe('答案是 B');
    expect(detail?.knowledge).toEqual([{ id: 'k1', label: '通假字' }]);
    expect(detail?.verify_status).toBe('unverified');
    expect(detail?.verify_reason).toBeNull();
  });

  it('gives null answer/options/passage when those fields are absent', async () => {
    const q = await seedQuestion({
      draft_status: 'draft',
      kind: 'short_answer',
      reference_md: null,
      choices_md: null,
    });
    const detail = await getDraftReviewDetail(testDb(), q);
    expect(detail?.answer).toBeNull();
    expect(detail?.options).toBeNull();
    expect(detail?.passage).toBeNull();
  });

  it('surfaces the passage from a stem structured tree', async () => {
    const q = await seedQuestion({
      draft_status: 'draft',
      kind: 'reading',
      structured: {
        id: 'root',
        role: 'stem',
        prompt_text: '阅读下面的文言文，完成题目。\n\n齐人有一妻一妾……',
        sub_questions: [{ id: 's1', role: 'sub', prompt_text: '解释加点字。' }],
      },
    });
    const detail = await getDraftReviewDetail(testDb(), q);
    expect(detail?.passage).toBe('阅读下面的文言文，完成题目。\n\n齐人有一妻一妾……');
  });

  it('carries the derived verify status + reason (latest terminal event)', async () => {
    const q = await seedQuestion({ draft_status: 'draft', source: 'quiz_gen' });
    await writeEvent(testDb(), {
      id: newId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'quiz_verify',
      action: 'experimental:quiz_verify',
      subject_kind: 'question',
      subject_id: q,
      outcome: 'partial',
      payload: { question_id: q, verification_status: 'needs_review', summary_md: '题意含糊' },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    const detail = await getDraftReviewDetail(testDb(), q);
    expect(detail?.verify_status).toBe('needs_review');
    expect(detail?.verify_reason).toBe('题意含糊');
  });

  it('returns null for a non-draft question (active)', async () => {
    const q = await seedQuestion({ draft_status: 'active' });
    expect(await getDraftReviewDetail(testDb(), q)).toBeNull();
  });

  it('returns null for a NULL draft_status question', async () => {
    const q = await seedQuestion({ draft_status: null });
    expect(await getDraftReviewDetail(testDb(), q)).toBeNull();
  });

  it('returns null for a soft-archived draft (metadata.archived_at set)', async () => {
    const q = await seedQuestion({
      draft_status: 'draft',
      metadata: { archived_at: Math.floor(Date.now() / 1000), archived_reason: 'deleted' },
    });
    expect(await getDraftReviewDetail(testDb(), q)).toBeNull();
  });

  it('returns null for a non-existent id', async () => {
    expect(await getDraftReviewDetail(testDb(), 'does-not-exist')).toBeNull();
  });
});

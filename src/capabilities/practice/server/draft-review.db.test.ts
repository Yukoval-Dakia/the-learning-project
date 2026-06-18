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
import { event, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { listDraftReview } from './draft-review';

async function seedQuestion(opts: {
  id?: string;
  source?: string;
  kind?: string;
  prompt_md?: string;
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
      knowledge_ids: [],
      difficulty: 3,
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
});

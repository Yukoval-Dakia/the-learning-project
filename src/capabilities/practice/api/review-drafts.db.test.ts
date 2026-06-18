// YUK-402 inc-4a — owner manual gate routes DB test.
//
// docs/superpowers/specs/2026-06-18-inc4-owner-manual-gate-design.md §2.
//
// Covers the 3 routes:
//   GET  /api/review/drafts                  — list projection + verify status + paging.
//   POST /api/review/drafts/[id]/enable      — normal verify→promote, 三态 translation.
//   POST /api/review/drafts/[id]/force-enable — override + reason 留痕 + B-section guards.
//
// The enable route is a thin shell over verifyAndPromote (its own behaviour is covered
// by verify-and-promote.db.test.ts); we mock the gate op to assert the route's HTTP
// translation (三态 mapping + 404) without dispatching a real verify. The list + the
// force-enable (override, no AI) routes run the REAL path against seeded rows.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newId } from '@/core/ids';
import { event, knowledge, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';

// ── enable route gate-op mock (thin-shell translation test) ──────────────────
const verifyAndPromoteMock = vi.fn();
vi.mock('@/server/quiz/verify-and-promote', () => ({
  verifyAndPromote: (...args: unknown[]) => verifyAndPromoteMock(...args),
}));

import { POST as enableDraft } from './review-draft-enable';
import { POST as forceEnableDraft } from './review-draft-force-enable';
import { GET as listDrafts } from './review-drafts-list';

async function seedKnowledge(id: string, archivedAt: Date | null = null): Promise<string> {
  await testDb().insert(knowledge).values({
    id,
    name: id,
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
  draft_status?: string | null;
  knowledge_ids?: string[];
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
      prompt_md: 'prompt',
      knowledge_ids: opts.knowledge_ids ?? [],
      difficulty: 3,
      source: opts.source ?? 'quiz_gen',
      draft_status: opts.draft_status === undefined ? 'draft' : opts.draft_status,
      metadata: (opts.metadata ?? null) as never,
      created_at: now,
      updated_at: now,
    });
  return id;
}

function listReq(query = ''): Request {
  return new Request(`http://localhost/api/review/drafts${query}`);
}
function actionReq(id: string, sub: 'enable' | 'force-enable', body?: unknown): Request {
  return new Request(`http://localhost/api/review/drafts/${id}/${sub}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('GET /api/review/drafts', () => {
  beforeEach(async () => {
    await resetDb();
    verifyAndPromoteMock.mockReset();
  });

  it('returns the draft pool page envelope (only drafts, with verify status)', async () => {
    const d = await seedQuestion({ draft_status: 'draft' });
    await seedQuestion({ draft_status: 'active' });

    const res = await listDrafts(listReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; verify_status: string }>;
      total: number;
      truncated: boolean;
    };
    expect(body.total).toBe(1);
    expect(body.rows.map((r) => r.id)).toEqual([d]);
    expect(body.rows[0].verify_status).toBe('unverified');
    expect(typeof body.truncated).toBe('boolean');
  });

  it('filters by source + paginates', async () => {
    await seedQuestion({
      draft_status: 'draft',
      source: 'quiz_gen',
      created_at: new Date(2026, 5, 1),
    });
    await seedQuestion({
      draft_status: 'draft',
      source: 'web_sourced',
      created_at: new Date(2026, 5, 2),
    });
    await seedQuestion({
      draft_status: 'draft',
      source: 'quiz_gen',
      created_at: new Date(2026, 5, 3),
    });

    const res = await listDrafts(listReq('?source=quiz_gen&limit=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; total: number; truncated: boolean };
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });

  it('rejects a negative offset with 400', async () => {
    const res = await listDrafts(listReq('?offset=-1'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/review/drafts/[id]/enable', () => {
  beforeEach(async () => {
    await resetDb();
    verifyAndPromoteMock.mockReset();
  });

  it('promoted → 200 { promoted:true, status:verified, verify_event_id }', async () => {
    verifyAndPromoteMock.mockResolvedValue({
      promoted: true,
      status: 'verified',
      verifyEventId: 'ev-1',
    });
    const res = await enableDraft(actionReq('q1', 'enable'), { id: 'q1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.promoted).toBe(true);
    expect(body.status).toBe('verified');
    expect(body.verify_event_id).toBe('ev-1');
    // gate called with actor=user.
    expect(verifyAndPromoteMock).toHaveBeenCalledTimes(1);
    const arg = verifyAndPromoteMock.mock.calls[0][0] as {
      actor: { kind: string };
      skipVerify?: unknown;
    };
    expect(arg.actor.kind).toBe('user');
    expect(arg.skipVerify).toBeUndefined();
  });

  it('needs_review → 200 { promoted:false, status:needs_review, reason }', async () => {
    verifyAndPromoteMock.mockResolvedValue({
      promoted: false,
      status: 'needs_review',
      reason: 'needs_review',
    });
    const res = await enableDraft(actionReq('q1', 'enable'), { id: 'q1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.promoted).toBe(false);
    expect(body.status).toBe('needs_review');
    expect(body.reason).toBe('needs_review');
  });

  it('failed → 200 { promoted:false, status:failed }', async () => {
    verifyAndPromoteMock.mockResolvedValue({ promoted: false, status: 'failed', reason: 'failed' });
    const res = await enableDraft(actionReq('q1', 'enable'), { id: 'q1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.promoted).toBe(false);
    expect(body.status).toBe('failed');
  });

  it('not_found → 404', async () => {
    verifyAndPromoteMock.mockResolvedValue({
      promoted: false,
      status: 'skipped:not_found',
      reason: 'question not found',
    });
    const res = await enableDraft(actionReq('missing', 'enable'), { id: 'missing' });
    expect(res.status).toBe(404);
  });

  it('blank id → 400', async () => {
    const res = await enableDraft(actionReq('', 'enable'), { id: '   ' });
    expect(res.status).toBe(400);
    expect(verifyAndPromoteMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/review/drafts/[id]/force-enable (override, real path)', () => {
  beforeEach(async () => {
    await resetDb();
    verifyAndPromoteMock.mockReset();
    // The force-enable route imports the REAL verifyAndPromote (override branch is
    // AI-free), but the module-level mock above replaces it. Route the mock straight
    // through to the real implementation for these tests so we exercise the actual
    // override promote + B-section guards end-to-end.
    const real = await vi.importActual<typeof import('@/server/quiz/verify-and-promote')>(
      '@/server/quiz/verify-and-promote',
    );
    verifyAndPromoteMock.mockImplementation(real.verifyAndPromote);
  });

  it('promotes a quiz_gen draft + writes a user-actor verify event (留痕)', async () => {
    await seedKnowledge('k1');
    const qid = await seedQuestion({ source: 'quiz_gen', knowledge_ids: ['k1'] });

    const res = await forceEnableDraft(actionReq(qid, 'force-enable', { reason: 'owner 判断' }), {
      id: qid,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.promoted).toBe(true);
    expect(body.verify_event_id).toBeTruthy();

    const row = (await testDb().select().from(question).where(eq(question.id, qid)).limit(1))[0];
    expect(row.draft_status).toBe('active');

    const ev = (
      await testDb()
        .select()
        .from(event)
        .where(and(eq(event.subject_kind, 'question'), eq(event.subject_id, qid)))
        .limit(1)
    )[0];
    expect(ev.actor_kind).toBe('user');
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.skipped_verify).toBe(true);
    expect(payload.reason).toBe('owner 判断');
  });

  it('rejects an empty reason with 400', async () => {
    const qid = await seedQuestion({ source: 'quiz_gen' });
    const res = await forceEnableDraft(actionReq(qid, 'force-enable', { reason: '   ' }), {
      id: qid,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing body with 400', async () => {
    const qid = await seedQuestion({ source: 'quiz_gen' });
    const res = await forceEnableDraft(actionReq(qid, 'force-enable'), { id: qid });
    expect(res.status).toBe(400);
  });

  it('B-archived-KC: override with an archived knowledge node → not promoted', async () => {
    await seedKnowledge('k-live');
    await seedKnowledge('k-dead', new Date());
    const qid = await seedQuestion({ source: 'quiz_gen', knowledge_ids: ['k-live', 'k-dead'] });

    const res = await forceEnableDraft(actionReq(qid, 'force-enable', { reason: 'forced' }), {
      id: qid,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.promoted).toBe(false);
    expect(body.status).toBe('skipped:archived_knowledge');
    const row = (await testDb().select().from(question).where(eq(question.id, qid)).limit(1))[0];
    expect(row.draft_status).toBe('draft');
  });

  it('B-archived-draft: override on a soft-archived draft → not revived', async () => {
    const qid = await seedQuestion({
      source: 'quiz_gen',
      metadata: { archived_at: Math.floor(Date.now() / 1000) },
    });
    const res = await forceEnableDraft(actionReq(qid, 'force-enable', { reason: 'forced' }), {
      id: qid,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.promoted).toBe(false);
    expect(body.status).toBe('skipped:archived_draft');
  });

  it('override on an unsupported source (teaching_check) → not promoted', async () => {
    const qid = await seedQuestion({ source: 'teaching_check' });
    const res = await forceEnableDraft(actionReq(qid, 'force-enable', { reason: 'forced' }), {
      id: qid,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.promoted).toBe(false);
    expect(body.status).toBe('skipped:unsupported_source');
  });

  it('not_found → 404', async () => {
    const res = await forceEnableDraft(actionReq('missing', 'force-enable', { reason: 'r' }), {
      id: 'missing',
    });
    expect(res.status).toBe(404);
  });
});

// YUK-214 (Strategy D · S1) — POST /api/ingestion/[id]/make-paper route +
// closed-loop bridge integration. Covers:
//   - happy path: imported session → 200 + artifact_id
//   - 409 when the session is not 'imported'
//   - 404 when the session does not exist
//   - the CLOSED LOOP (the slice's acceptance core): make-paper → getPracticeList
//     contains the paper → POST /api/practice starts a session → submitPaperSlot
//     writes attempt + independent judge events + knowledge-keyed FSRS.
//
// Uses the deterministic `exact` judge (true_false matched against reference_md)
// — no LLM / runTask mock needed (mirrors paper-cycle.test.ts).

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  artifact,
  event,
  knowledge,
  learning_session,
  question,
  source_document,
} from '@/db/schema';
import { getFsrsState } from '@/server/fsrs/state';
import { submitPaperSlot } from '@/server/review/paper-submit';
import { getPracticeList } from '@/server/review/practice-read';
import { Review } from '@/server/session';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { POST } from './route';

async function seedKnowledge(id: string) {
  const db = testDb();
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain: 'wenyan',
      parent_id: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedImportedSession(opts: {
  sessionId: string;
  status?: string;
  questions?: Array<{ id: string; knowledge_ids: string[]; reference_md?: string }>;
}) {
  const db = testDb();
  const now = new Date();
  const docId = createId();
  await db.insert(source_document).values({
    id: docId,
    title: '导入卷',
    source_asset_ids: [],
    body_md: null,
    provenance: {} as Record<string, unknown>,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(learning_session).values({
    id: opts.sessionId,
    type: 'ingestion',
    source_document_id: docId,
    source_asset_ids: [],
    status: opts.status ?? 'imported',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  for (const q of opts.questions ?? []) {
    for (const k of q.knowledge_ids) await seedKnowledge(k);
    await db.insert(question).values({
      id: q.id,
      kind: 'true_false',
      prompt_md: `Prompt ${q.id}`,
      reference_md: q.reference_md ?? 'true',
      knowledge_ids: q.knowledge_ids,
      difficulty: 3,
      source: 'vision_single',
      variant_depth: 0,
      metadata: { ingestion_session_id: opts.sessionId, source_document_id: docId },
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
}

function post(sessionId: string, body: unknown) {
  const req = new Request(`http://localhost/api/ingestion/${sessionId}/make-paper`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: sessionId }) });
}

describe('POST /api/ingestion/[id]/make-paper (YUK-214)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('builds a paper from an imported session (200 + artifact_id)', async () => {
    await seedImportedSession({
      sessionId: 'sess_ok',
      questions: [{ id: 'q1', knowledge_ids: ['k1'] }],
    });
    const res = await post('sess_ok', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact_id: string };
    expect(body.artifact_id).toMatch(/^ingestion_paper_/);
  });

  it('rejects a session that is not imported (409)', async () => {
    await seedImportedSession({
      sessionId: 'sess_extracted',
      status: 'extracted',
      questions: [{ id: 'q2', knowledge_ids: ['k1'] }],
    });
    const res = await post('sess_extracted', {});
    expect(res.status).toBe(409);
  });

  it('returns 404 when the session does not exist', async () => {
    const res = await post('sess_missing', {});
    expect(res.status).toBe(404);
  });

  // F2 (PR #309 round-2) — a malformed JSON body (the caller MEANT to send
  // question_ids but the bytes are corrupt) must 400 invalid_json, NOT silently
  // fall back to a default full-set paper. No artifact is created.
  it('returns 400 invalid_json for a malformed body and creates no paper', async () => {
    await seedImportedSession({
      sessionId: 'sess_malformed',
      questions: [{ id: 'qm1', knowledge_ids: ['k1'] }],
    });
    const req = new Request('http://localhost/api/ingestion/sess_malformed/make-paper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ "question_ids": ', // truncated → not valid JSON
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'sess_malformed' }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_json');

    // No side effect: the malformed request must not have built a paper.
    const db = testDb();
    const rows = await db
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.source_ref, 'sess_malformed'));
    expect(rows).toHaveLength(0);
  });

  // F2 — a TRULY-EMPTY body (Content-Length 0 / no bytes) is the legitimate
  // no-override case → 200 default full-set paper.
  it('treats an empty body as the default full-set request (200)', async () => {
    await seedImportedSession({
      sessionId: 'sess_empty_body',
      questions: [{ id: 'qe1', knowledge_ids: ['k1'] }],
    });
    const req = new Request('http://localhost/api/ingestion/sess_empty_body/make-paper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // no body at all
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'sess_empty_body' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact_id: string };
    expect(body.artifact_id).toMatch(/^ingestion_paper_/);
  });

  it('CLOSED LOOP: make-paper → /practice list → start session → submit slot', async () => {
    await seedImportedSession({
      sessionId: 'sess_loop',
      questions: [
        { id: 'lq1', knowledge_ids: ['k1'], reference_md: 'true' },
        { id: 'lq2', knowledge_ids: ['k2'], reference_md: 'true' },
      ],
    });
    const db = testDb();

    // 1. make-paper
    const mk = await post('sess_loop', {});
    expect(mk.status).toBe(200);
    const { artifact_id: artifactId } = (await mk.json()) as { artifact_id: string };

    // 2. the paper appears in the practice list with the right slot count
    const list = await getPracticeList(db);
    const paper = list.papers.find((p) => p.artifact_id === artifactId);
    expect(paper).toBeDefined();
    expect(paper?.total_slots).toBe(2);
    // source folds into 'other' (no dedicated tab yet)
    expect(paper?.source).toBe('other');

    // 3. start a review session bound to the paper (mirrors POST /api/practice)
    const { sessionId: reviewSessionId } = await Review.startReviewSession(db, { artifactId });
    expect(reviewSessionId).toBeTruthy();

    // 4. submit one slot — correct answer → attempt(success) + judge + FSRS
    const submit = await submitPaperSlot(
      {
        sessionId: reviewSessionId,
        paperArtifactId: artifactId,
        questionId: 'lq1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(submit.coarseOutcome).toBe('correct');
    expect(submit.visibleToUser).toBe(true);

    // attempt + independent judge events written, judge chains the attempt
    const attempt = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.subject_id, 'lq1')));
    expect(attempt).toHaveLength(1);
    expect(attempt[0].outcome).toBe('success');

    const judge = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.subject_kind, 'event')));
    expect(judge).toHaveLength(1);
    expect(judge[0].subject_id).toBe(submit.attemptEventId);

    // knowledge-keyed FSRS projection updated for the slot's primary knowledge
    const fsrs = await getFsrsState(db, 'knowledge', 'k1');
    expect(fsrs).not.toBeNull();
  });
});

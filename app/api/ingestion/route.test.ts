/**
 * Tests for POST /api/ingestion (Sub 0c migration —— just creates session,
 * no sync extract). 抽取走 POST /api/ingestion/[id]/extract + worker.
 */

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  event,
  learning_session,
  question_block,
  source_asset,
  source_document,
} from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { GET, POST } from './route';

async function insertAsset(db: ReturnType<typeof testDb>, id: string, storageKey: string) {
  await db.insert(source_asset).values({
    id,
    kind: 'image',
    storage_key: storageKey,
    mime_type: 'image/png',
    byte_size: 8,
    sha256: '0'.repeat(64),
    created_at: new Date(),
  });
}

function postBody(overrides: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/ingestion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entrypoint: 'vision_single',
      asset_ids: ['asset_1'],
      ...overrides,
    }),
  });
}

describe('POST /api/ingestion', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates ingestion_session(status=uploaded) + source_document, returns session', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_1', 'sk_1');
    await insertAsset(db, 'asset_2', 'sk_2');

    const res = await POST(postBody({ asset_ids: ['asset_1', 'asset_2'] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: {
        id: string;
        source_document_id: string;
        status: string;
        source_asset_ids: string[];
        entrypoint: string;
      };
    };
    expect(body.session.status).toBe('uploaded');
    expect(body.session.entrypoint).toBe('vision_single');
    expect(body.session.source_asset_ids).toEqual(['asset_1', 'asset_2']);
    expect(body.session.id).toBeTruthy();
    expect(body.session.source_document_id).toBeTruthy();

    const sessions = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, body.session.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('uploaded');

    const docs = await db
      .select()
      .from(source_document)
      .where(eq(source_document.id, body.session.source_document_id));
    expect(docs).toHaveLength(1);
    expect(docs[0].source_asset_ids).toEqual(['asset_1', 'asset_2']);
  });

  it('unknown asset_id → 400 with missing id, no session insert', async () => {
    const db = testDb();
    await insertAsset(db, 'asset_real', 'sk_r');

    const res = await POST(postBody({ asset_ids: ['asset_real', 'asset_missing'] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/asset_missing/);

    const sessions = await db.select().from(learning_session);
    expect(sessions).toHaveLength(0);
  });

  it('empty asset_ids → 400', async () => {
    const res = await POST(postBody({ asset_ids: [] }));
    expect(res.status).toBe(400);
  });

  it('asset_ids over max (6) → 400', async () => {
    const res = await POST(postBody({ asset_ids: ['a', 'b', 'c', 'd', 'e', 'f'] }));
    expect(res.status).toBe(400);
  });

  it('invalid entrypoint → 400', async () => {
    const res = await POST(postBody({ entrypoint: 'not_valid' }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/ingestion — recent ingestion-session list for the OC-5 review surface
// (YUK-164 #2). DB partition (same testcontainer Postgres as POST above).
// ---------------------------------------------------------------------------

async function seedIngestionSession(opts: {
  id: string;
  created_at: Date;
  entrypoint?: string | null;
  status?: string;
  type?: string;
  source_asset_ids?: string[];
}): Promise<void> {
  const db = testDb();
  await db.insert(learning_session).values({
    id: opts.id,
    type: opts.type ?? 'ingestion',
    status: opts.status ?? 'extracted',
    source_document_id: null,
    source_asset_ids: opts.source_asset_ids ?? [],
    entrypoint: opts.entrypoint === undefined ? 'vision_single' : opts.entrypoint,
    warnings: [],
    error_message: null,
    summary_md: null,
    goal_id: null,
    started_at: opts.created_at,
    ended_at: null,
    version: 0,
    created_at: opts.created_at,
    updated_at: opts.created_at,
  });
}

async function seedBlock(opts: {
  id: string;
  session_id: string;
  status?: string;
  created_at?: Date;
}): Promise<void> {
  const db = testDb();
  const now = opts.created_at ?? new Date();
  await db.insert(question_block).values({
    id: opts.id,
    ingestion_session_id: opts.session_id,
    source_document_id: null,
    source_asset_ids: [],
    page_spans: [],
    extracted_prompt_md: null,
    structured: null,
    figures: [],
    layout_quality: 'structured',
    reference_md: null,
    wrong_answer_md: null,
    image_refs: [],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 0.9,
    status: opts.status ?? 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_attempt_event_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedObserveEvent(opts: { id: string; block_id: string }): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'workflow_judge',
    action: 'experimental:auto_enroll_observed',
    subject_kind: 'question_block',
    subject_id: opts.block_id,
    outcome: 'success',
    payload: {
      mode: 'observe',
      route: 'auto',
      confidence: 0.9,
      threshold: 0.85,
      suggested_knowledge_ids: [],
    },
    caused_by_event_id: null,
    affected_scopes: [],
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
    ingest_at: now,
  });
}

async function getSessions(query = ''): Promise<Response> {
  return GET(new Request(`http://localhost/api/ingestion${query}`, { method: 'GET' }));
}

interface SessionRow {
  id: string;
  entrypoint: string | null;
  status: string;
  source_asset_ids: string[];
  observation_count: number;
  auto_enrolled_count: number;
  block_count: number;
  created_at: number;
}

describe('GET /api/ingestion', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('empty DB → { rows: [] }', async () => {
    const res = await getSessions();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: SessionRow[] };
    expect(body.rows).toEqual([]);
  });

  it('returns sessions newest-first, only those with ≥1 block', async () => {
    // older session, has a block
    await seedIngestionSession({ id: 'old', created_at: new Date('2026-05-01T00:00:00Z') });
    await seedBlock({ id: 'old_b1', session_id: 'old' });
    // newer session, has a block
    await seedIngestionSession({ id: 'new', created_at: new Date('2026-05-10T00:00:00Z') });
    await seedBlock({ id: 'new_b1', session_id: 'new' });
    // session with no blocks → excluded
    await seedIngestionSession({ id: 'empty', created_at: new Date('2026-05-09T00:00:00Z') });

    const res = await getSessions();
    const body = (await res.json()) as { rows: SessionRow[] };
    expect(body.rows.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('newest block-less sessions do not crowd an older with-block session out of the limit', async () => {
    // Regression for codex/CodeRabbit: an in-memory `block_count>0` post-filter ran
    // AFTER orderBy+limit, so when the newest `limit` sessions were mostly block-less
    // they consumed the slots and a valid older session was silently dropped. The
    // ≥1-block predicate is now pushed into SQL (EXISTS) BEFORE orderBy+limit.
    // Seed: one OLD session WITH a block, then `limit` NEWER sessions WITHOUT blocks.
    await seedIngestionSession({ id: 'old_valid', created_at: new Date('2026-05-01T00:00:00Z') });
    await seedBlock({ id: 'old_valid_b', session_id: 'old_valid' });
    for (let i = 0; i < 20; i++) {
      // strictly newer than old_valid, no block each
      await seedIngestionSession({
        id: `newer_empty_${i}`,
        created_at: new Date(`2026-05-${String(i + 2).padStart(2, '0')}T00:00:00Z`),
      });
    }

    // default limit = 20, exactly the count of newer block-less sessions.
    const res = await getSessions();
    const body = (await res.json()) as { rows: SessionRow[] };
    // Only the with-block session surfaces; the 20 block-less newer ones are
    // filtered in SQL and never squeeze it out.
    expect(body.rows.map((r) => r.id)).toEqual(['old_valid']);
  });

  it('limit clamps to 1..100 (limit=0 → 1, limit=999 → 100)', async () => {
    // three sessions each with a block, distinct created_at
    for (let i = 0; i < 3; i++) {
      const sid = `s${i}`;
      await seedIngestionSession({
        id: sid,
        created_at: new Date(`2026-05-0${i + 1}T00:00:00Z`),
      });
      await seedBlock({ id: `${sid}_b`, session_id: sid });
    }

    const clampedLow = await getSessions('?limit=0');
    const lowBody = (await clampedLow.json()) as { rows: SessionRow[] };
    expect(lowBody.rows).toHaveLength(1); // clamped to MIN 1

    const clampedHigh = await getSessions('?limit=999');
    const highBody = (await clampedHigh.json()) as { rows: SessionRow[] };
    expect(highBody.rows).toHaveLength(3); // clamped to MAX 100, but only 3 exist
  });

  it('counts blocks, auto_enrolled blocks, and observation events per session', async () => {
    await seedIngestionSession({ id: 'sess1', created_at: new Date('2026-05-05T00:00:00Z') });
    // M=3 blocks; K=1 auto_enrolled
    await seedBlock({ id: 'b1', session_id: 'sess1', status: 'draft' });
    await seedBlock({ id: 'b2', session_id: 'sess1', status: 'auto_enrolled' });
    await seedBlock({ id: 'b3', session_id: 'sess1', status: 'draft' });
    // J=2 observation events (on b1 and b3)
    await seedObserveEvent({ id: 'evt1', block_id: 'b1' });
    await seedObserveEvent({ id: 'evt2', block_id: 'b3' });

    const res = await getSessions();
    const body = (await res.json()) as { rows: SessionRow[] };
    const row = body.rows.find((r) => r.id === 'sess1');
    expect(row).toBeDefined();
    expect(row?.block_count).toBe(3);
    expect(row?.auto_enrolled_count).toBe(1);
    expect(row?.observation_count).toBe(2);
  });

  it('excludes non-ingestion learning_session rows', async () => {
    await seedIngestionSession({
      id: 'review_sess',
      type: 'review',
      created_at: new Date('2026-05-06T00:00:00Z'),
    });
    // give it a block so it would surface IF the type filter were missing
    await seedBlock({ id: 'rb1', session_id: 'review_sess' });
    await seedIngestionSession({ id: 'ing_sess', created_at: new Date('2026-05-07T00:00:00Z') });
    await seedBlock({ id: 'ib1', session_id: 'ing_sess' });

    const res = await getSessions();
    const body = (await res.json()) as { rows: SessionRow[] };
    expect(body.rows.map((r) => r.id)).toEqual(['ing_sess']);
  });

  it('created_at is unix seconds (integer); entrypoint passes through', async () => {
    const created = new Date('2026-05-08T00:00:00Z');
    await seedIngestionSession({
      id: 'sess1',
      created_at: created,
      entrypoint: 'vision_paper',
    });
    await seedBlock({ id: 'b1', session_id: 'sess1' });

    const res = await getSessions();
    const body = (await res.json()) as { rows: SessionRow[] };
    const row = body.rows[0];
    expect(row.created_at).toBe(Math.floor(created.getTime() / 1000));
    expect(Number.isInteger(row.created_at)).toBe(true);
    expect(row.entrypoint).toBe('vision_paper');
  });
});

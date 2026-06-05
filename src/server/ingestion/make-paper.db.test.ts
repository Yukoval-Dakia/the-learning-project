// YUK-214 (Strategy D · S1) — DB integration for createIngestionPaper: the full
// write path (reverse-query imported questions → build → INSERT artifact) +
// idempotency (a second call for the same session returns the existing paper).
// The pure builder shape is covered by make-paper.unit.test.ts (unit partition).

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { Artifact } from '@/core/schema/index';
import {
  artifact,
  knowledge,
  learning_session,
  question,
  question_block,
  source_document,
} from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { createIngestionPaper } from './make-paper';

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

/** Seed an ingestion session + source document + N imported questions whose
 *  metadata carries ingestion_session_id (mirrors import/route's write).
 *
 *  When a question carries `block_created_at`, a matching `question_block` row is
 *  also seeded (with that created_at) and linked via
 *  `metadata.question_block_id` — mirroring import/route's write so the F3
 *  block-order reverse-query can be exercised. All imported questions share one
 *  `now` (as the real import route does), so the block's created_at is the only
 *  thing that can carry the original paper order. */
async function seedImportedSession(opts: {
  sessionId: string;
  questions: Array<{ id: string; knowledge_ids: string[]; block_created_at?: Date }>;
  docTitle?: string | null;
}) {
  const db = testDb();
  const now = new Date();
  const docId = createId();
  await db.insert(source_document).values({
    id: docId,
    title: opts.docTitle ?? null,
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
    status: 'imported',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  for (const q of opts.questions) {
    for (const k of q.knowledge_ids) await seedKnowledge(k);
    let blockId: string | undefined;
    if (q.block_created_at) {
      blockId = createId();
      await db.insert(question_block).values({
        id: blockId,
        ingestion_session_id: opts.sessionId,
        source_document_id: docId,
        source_asset_ids: [],
        page_spans: [],
        extracted_prompt_md: `Prompt ${q.id}`,
        reference_md: null,
        wrong_answer_md: null,
        image_refs: [],
        crop_refs: [],
        visual_complexity: 'low',
        extraction_confidence: 1,
        status: 'imported',
        knowledge_hint: null,
        merged_from_block_ids: [],
        imported_question_id: q.id,
        imported_attempt_event_id: null,
        // The block carries the original paper order via its extraction time.
        created_at: q.block_created_at,
        updated_at: q.block_created_at,
        version: 0,
      });
    }
    await db.insert(question).values({
      id: q.id,
      kind: 'short_answer',
      prompt_md: `Prompt ${q.id}`,
      reference_md: null,
      knowledge_ids: q.knowledge_ids,
      difficulty: 3,
      source: 'vision_single',
      variant_depth: 0,
      metadata: {
        ingestion_session_id: opts.sessionId,
        source_document_id: docId,
        // Link to the source block (import/route.ts:407) when one was seeded.
        ...(blockId ? { question_block_id: blockId } : {}),
      },
      // All imported questions share one `now` (import/route.ts:250).
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
  return { docId };
}

describe('createIngestionPaper (YUK-214)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('reverse-queries imported questions and writes a tool_quiz artifact', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_a',
      questions: [
        { id: 'q1', knowledge_ids: ['k1', 'k2'] },
        { id: 'q2', knowledge_ids: ['k3'] },
      ],
      docTitle: '期中卷',
    });

    const { artifactId, reused } = await createIngestionPaper(db, { sessionId: 'sess_a' });
    expect(reused).toBe(false);

    const [row] = await db.select().from(artifact).where(eq(artifact.id, artifactId)).limit(1);
    const paper = Artifact.parse(row);
    expect(paper.type).toBe('tool_quiz');
    expect(paper.intent_source).toBe('ingestion_paper');
    expect(paper.tool_kind).toBe('ingestion_paper');
    expect(paper.source).toBe('imported');
    expect(paper.source_ref).toBe('sess_a');
    expect(paper.title).toBe('期中卷');
    expect(paper.generation_status).toBe('ready');
    expect(paper.knowledge_ids.sort()).toEqual(['k1', 'k2', 'k3']);

    // One section, one assignment per imported question, FSRS-keyed on primary.
    expect(paper.tool_state?.question_ids).toEqual(['q1', 'q2']);
    const section = paper.tool_state?.sections?.[0];
    expect(section?.feedback_policy).toBe('immediate');
    expect(section?.assignments).toHaveLength(2);
    expect(section?.assignments[0].primary_knowledge_id).toBe('k1');
    expect(section?.assignments[0].secondary_knowledge_ids).toEqual(['k2']);
  });

  it('falls back to the default title when source_document.title is null', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_b',
      questions: [{ id: 'qb1', knowledge_ids: ['k1'] }],
      docTitle: null,
    });
    const { artifactId } = await createIngestionPaper(db, { sessionId: 'sess_b' });
    const [row] = await db.select().from(artifact).where(eq(artifact.id, artifactId)).limit(1);
    expect(row.title).toBe('导入试卷');
  });

  it('is idempotent on sessionId — a second call returns the same paper', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_c',
      questions: [{ id: 'qc1', knowledge_ids: ['k1'] }],
    });
    const first = await createIngestionPaper(db, { sessionId: 'sess_c' });
    const second = await createIngestionPaper(db, { sessionId: 'sess_c' });
    expect(second.reused).toBe(true);
    expect(second.artifactId).toBe(first.artifactId);

    const rows = await db
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.source_ref, 'sess_c'));
    expect(rows).toHaveLength(1);
  });

  // F1 (PR #309 round-2) — idempotency must account for the question set. A
  // second call with a DIFFERENT explicit questionIds set conflicts with the
  // existing one-session-one-paper artifact → 409 (no silent stale reuse).
  it('409s when a second call passes a different explicit questionIds set', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_f1_conflict',
      questions: [
        { id: 'qfc1', knowledge_ids: ['k1'] },
        { id: 'qfc2', knowledge_ids: ['k2'] },
      ],
    });
    const first = await createIngestionPaper(db, {
      sessionId: 'sess_f1_conflict',
      questionIds: ['qfc1'],
    });
    expect(first.reused).toBe(false);

    // A different set on the same session must NOT silently return the qfc1 paper.
    await expect(
      createIngestionPaper(db, { sessionId: 'sess_f1_conflict', questionIds: ['qfc2'] }),
    ).rejects.toMatchObject({ status: 409 });

    // Still exactly one paper for the session (the conflict did not create one).
    const rows = await db
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.source_ref, 'sess_f1_conflict'));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.artifactId);
  });

  // F1 — the SAME explicit set is still idempotent (returns the existing paper).
  it('reuses the existing paper when the same explicit questionIds set is passed again', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_f1_same',
      questions: [
        { id: 'qfs1', knowledge_ids: ['k1'] },
        { id: 'qfs2', knowledge_ids: ['k2'] },
      ],
    });
    const first = await createIngestionPaper(db, {
      sessionId: 'sess_f1_same',
      questionIds: ['qfs1', 'qfs2'],
    });
    const second = await createIngestionPaper(db, {
      sessionId: 'sess_f1_same',
      questionIds: ['qfs1', 'qfs2'],
    });
    expect(second.reused).toBe(true);
    expect(second.artifactId).toBe(first.artifactId);
  });

  // F4 (PR #309 round-3, YUK-214 / CodeRabbit) — the create branch filters
  // questionIds to the session (dropping ids that are not imported in it) and
  // stores the NORMALIZED set. The reuse-branch idempotency comparison must
  // normalize the replayed request the SAME way before comparing. Pre-fix it
  // compared the stored (filtered) set against the RAW request, so a replay of the
  // exact same request that included a session-EXTERNAL id self-409'd. Now the same
  // request replays idempotently.
  it('F4: replaying a request that includes a session-external id stays idempotent (no self-409)', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_f4',
      questions: [
        { id: 'qf4a', knowledge_ids: ['k1'] },
        { id: 'qf4b', knowledge_ids: ['k2'] },
      ],
    });
    // A different session whose question is NOT in sess_f4 — the external id.
    await seedImportedSession({
      sessionId: 'sess_f4_other',
      questions: [{ id: 'qf4_ext', knowledge_ids: ['k3'] }],
    });

    // First build includes the external id; it is filtered out → stored set is
    // ['qf4a', 'qf4b'].
    const first = await createIngestionPaper(db, {
      sessionId: 'sess_f4',
      questionIds: ['qf4a', 'qf4b', 'qf4_ext'],
    });
    expect(first.reused).toBe(false);
    const [row] = await db
      .select()
      .from(artifact)
      .where(eq(artifact.id, first.artifactId))
      .limit(1);
    expect((row.tool_state as { question_ids?: string[] }).question_ids).toEqual(['qf4a', 'qf4b']);

    // Replaying the EXACT same request (external id included) must be idempotent,
    // not a 409 — the normalized request equals the stored set.
    const second = await createIngestionPaper(db, {
      sessionId: 'sess_f4',
      questionIds: ['qf4a', 'qf4b', 'qf4_ext'],
    });
    expect(second.reused).toBe(true);
    expect(second.artifactId).toBe(first.artifactId);

    // A genuinely-different in-session set still 409s (F1 unchanged).
    await expect(
      createIngestionPaper(db, { sessionId: 'sess_f4', questionIds: ['qf4b', 'qf4a'] }),
    ).rejects.toMatchObject({ status: 409 });
  });

  // F3 (PR #309 round-3, YUK-214) — the service layer rejects an EXPLICIT empty
  // array (≠ default full-set). `undefined` falls through to full-set; `[]` 400s.
  it('F3: an explicit empty questionIds array is rejected (400), undefined is not', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_f3',
      questions: [{ id: 'qf3a', knowledge_ids: ['k1'] }],
    });
    await expect(
      createIngestionPaper(db, { sessionId: 'sess_f3', questionIds: [] }),
    ).rejects.toMatchObject({ status: 400 });
    // undefined → default full-set path builds normally (control).
    const ok = await createIngestionPaper(db, { sessionId: 'sess_f3' });
    expect(ok.reused).toBe(false);
  });

  // F1 — the default (no questionIds) path stays purely idempotent even after a
  // paper was first built from an explicit subset: a bare call carries no set to
  // conflict with, so it reuses rather than 409s.
  it('default (no questionIds) path reuses the existing paper without conflict', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_f1_default',
      questions: [
        { id: 'qfd1', knowledge_ids: ['k1'] },
        { id: 'qfd2', knowledge_ids: ['k2'] },
      ],
    });
    const first = await createIngestionPaper(db, {
      sessionId: 'sess_f1_default',
      questionIds: ['qfd1'],
    });
    const second = await createIngestionPaper(db, { sessionId: 'sess_f1_default' });
    expect(second.reused).toBe(true);
    expect(second.artifactId).toBe(first.artifactId);
  });

  it('honours an explicit questionIds override (intersected with the session)', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_d',
      questions: [
        { id: 'qd1', knowledge_ids: ['k1'] },
        { id: 'qd2', knowledge_ids: ['k2'] },
      ],
    });
    const { artifactId } = await createIngestionPaper(db, {
      sessionId: 'sess_d',
      questionIds: ['qd1'],
    });
    const [row] = await db.select().from(artifact).where(eq(artifact.id, artifactId)).limit(1);
    const paper = Artifact.parse(row);
    expect(paper.tool_state?.question_ids).toEqual(['qd1']);
  });

  // F2 (PR #309 round-1) — paper slot order is deterministic, not whatever order
  // the DB happens to return rows in.
  it('preserves the requested questionIds order even when ids are passed out of order', async () => {
    const db = testDb();
    // Seed ids whose lexical/insertion order is NOT the requested order, so a
    // bare inArray would scramble them.
    await seedImportedSession({
      sessionId: 'sess_f',
      questions: [
        { id: 'qf_a', knowledge_ids: ['k1'] },
        { id: 'qf_b', knowledge_ids: ['k2'] },
        { id: 'qf_c', knowledge_ids: ['k3'] },
      ],
    });
    const requested = ['qf_c', 'qf_a', 'qf_b'];
    const { artifactId } = await createIngestionPaper(db, {
      sessionId: 'sess_f',
      questionIds: requested,
    });
    const [row] = await db.select().from(artifact).where(eq(artifact.id, artifactId)).limit(1);
    const paper = Artifact.parse(row);
    expect(paper.tool_state?.question_ids).toEqual(requested);
  });

  // F3 (PR #309 round-2) — the reverse-query fall-through path orders by the
  // SOURCE paper's block order (question_block.created_at), NOT by question.id.
  // All imported questions share one question.created_at, so an id-only sort
  // (round-1) produced a deterministic-but-arbitrary order. The block's
  // extraction-time created_at carries the real paper sequence; the reverse
  // query joins question→question_block and orders by it, so the paper's slot
  // order equals the original on-screen block order.
  it('orders fall-through reverse-queried questions by the source block order (created_at), not id', async () => {
    const db = testDb();
    // Block order (paper order): qg_3 (t0) → qg_1 (t1) → qg_2 (t2). The question
    // ids are deliberately NOT in that order, so an id-sort would scramble the
    // paper; a block-created_at sort reconstructs the true paper sequence.
    const t0 = new Date('2026-06-01T00:00:00.000Z');
    const t1 = new Date('2026-06-01T00:00:01.000Z');
    const t2 = new Date('2026-06-01T00:00:02.000Z');
    await seedImportedSession({
      sessionId: 'sess_g',
      questions: [
        { id: 'qg_1', knowledge_ids: ['k1'], block_created_at: t1 },
        { id: 'qg_2', knowledge_ids: ['k2'], block_created_at: t2 },
        { id: 'qg_3', knowledge_ids: ['k3'], block_created_at: t0 },
      ],
    });
    const { artifactId } = await createIngestionPaper(db, { sessionId: 'sess_g' });
    const [row] = await db.select().from(artifact).where(eq(artifact.id, artifactId)).limit(1);
    const paper = Artifact.parse(row);
    // Block order, NOT id order (which would be qg_1, qg_2, qg_3).
    expect(paper.tool_state?.question_ids).toEqual(['qg_3', 'qg_1', 'qg_2']);
  });

  it('throws when the session has no imported questions', async () => {
    const db = testDb();
    await seedImportedSession({ sessionId: 'sess_e', questions: [] });
    await expect(createIngestionPaper(db, { sessionId: 'sess_e' })).rejects.toThrow(
      /no imported questions/i,
    );
  });
});

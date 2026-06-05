// YUK-214 (Strategy D · S1) — DB integration for createIngestionPaper: the full
// write path (reverse-query imported questions → build → INSERT artifact) +
// idempotency (a second call for the same session returns the existing paper).
// The pure builder shape is covered by make-paper.unit.test.ts (unit partition).

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { Artifact } from '@/core/schema/index';
import { artifact, knowledge, learning_session, question, source_document } from '@/db/schema';
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
 *  metadata carries ingestion_session_id (mirrors import/route's write). */
async function seedImportedSession(opts: {
  sessionId: string;
  questions: Array<{ id: string; knowledge_ids: string[] }>;
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
    await db.insert(question).values({
      id: q.id,
      kind: 'short_answer',
      prompt_md: `Prompt ${q.id}`,
      reference_md: null,
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

  it('throws when the session has no imported questions', async () => {
    const db = testDb();
    await seedImportedSession({ sessionId: 'sess_e', questions: [] });
    await expect(createIngestionPaper(db, { sessionId: 'sess_e' })).rejects.toThrow(
      /no imported questions/i,
    );
  });
});

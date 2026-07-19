import { db } from '@/db/client';
import { event, question } from '@/db/schema';
import { archiveQuestion } from '@/server/questions/write';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../tests/helpers/db';
import {
  canonicalQuestionContentHash,
  findExactQuestionDuplicate,
  mergeExactQuestionDuplicateKnowledgeIds,
} from './content-fingerprint';

async function seed(id: string, draftStatus: string | null, knowledgeIds: string[] = []) {
  const content = { promptMd: 'P', referenceMd: 'A', choicesMd: ['x', 'y'] };
  const hash = canonicalQuestionContentHash(content);
  await db.insert(question).values({
    id,
    kind: 'choice',
    prompt_md: content.promptMd,
    reference_md: content.referenceMd,
    choices_md: content.choicesMd,
    source: 'manual',
    draft_status: draftStatus,
    knowledge_ids: knowledgeIds,
    canonical_content_hash: hash,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return hash;
}

describe('findExactQuestionDuplicate', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it.each([
    ['active', null],
    ['draft', 'draft'],
  ] as const)('finds %s rows by canonical hash', async (_label, status) => {
    const hash = await seed(`q-${_label}`, status);
    expect(await findExactQuestionDuplicate(db, hash)).toMatchObject({
      id: `q-${_label}`,
      draftStatus: status,
    });
  });

  it('archiving releases the canonical hash so identical content can be produced again', async () => {
    const hash = await seed('q-archived', null);
    const [before] = await db.select().from(question).where(eq(question.id, 'q-archived'));
    const result = await archiveQuestion(db, 'q-archived', before.version, 'owner');
    expect(result.status).toBe('archived');

    const [after] = await db.select().from(question).where(eq(question.id, 'q-archived'));
    expect(after.canonical_content_hash).toBeNull();
    // The freed hash no longer duplicate-matches, and the partial unique index
    // accepts a fresh row carrying the same content identity.
    expect(await findExactQuestionDuplicate(db, hash)).toBeNull();
    await seed('q-reborn', 'draft');
    expect(await findExactQuestionDuplicate(db, hash)).toMatchObject({ id: 'q-reborn' });
  });

  it('keeps legacy NULL-hash rows readable and outside exact identity lookup', async () => {
    await db.insert(question).values({
      id: 'q-legacy-null',
      kind: 'short_answer',
      prompt_md: 'legacy',
      source: 'manual',
      canonical_content_hash: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(
      await findExactQuestionDuplicate(db, canonicalQuestionContentHash({ promptMd: 'legacy' })),
    ).toBeNull();
    expect(await db.select().from(question).where(eq(question.id, 'q-legacy-null'))).toHaveLength(
      1,
    );
  });

  it('atomically appends missing KCs, preserves lifecycle, audits once, and no-ops on retry', async () => {
    const hash = await seed('q-cross-kc', 'active', ['k-a']);
    const now = new Date('2026-07-19T11:00:00.000Z');

    const first = await db.transaction((tx) =>
      mergeExactQuestionDuplicateKnowledgeIds(tx, {
        canonicalContentHash: hash,
        knowledgeIds: ['k-a', 'k-b', 'k-b'],
        actorRef: 'quiz_gen',
        now,
      }),
    );
    expect(first).toMatchObject({
      id: 'q-cross-kc',
      draftStatus: 'active',
      previousKnowledgeIds: ['k-a'],
      knowledgeIds: ['k-a', 'k-b'],
      addedKnowledgeIds: ['k-b'],
      previousVersion: 0,
      version: 1,
      eventId: expect.any(String),
    });

    const [row] = await db.select().from(question).where(eq(question.id, 'q-cross-kc'));
    expect(row).toMatchObject({
      knowledge_ids: ['k-a', 'k-b'],
      draft_status: 'active',
      version: 1,
      updated_at: now,
    });
    const editEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:question_edit'));
    expect(editEvents).toHaveLength(1);
    expect(editEvents[0]).toMatchObject({
      actor_kind: 'agent',
      actor_ref: 'quiz_gen',
      subject_kind: 'question',
      subject_id: 'q-cross-kc',
      payload: {
        previous_version: 0,
        next_version: 1,
        before: { knowledge_ids: ['k-a'] },
        after: { knowledge_ids: ['k-a', 'k-b'] },
        reason: 'cross_kc_exact_duplicate',
        added_knowledge_ids: ['k-b'],
        preserved_draft_status: 'active',
      },
    });

    const retry = await db.transaction((tx) =>
      mergeExactQuestionDuplicateKnowledgeIds(tx, {
        canonicalContentHash: hash,
        knowledgeIds: ['k-b'],
        actorRef: 'sourcing',
        now: new Date('2026-07-19T12:00:00.000Z'),
      }),
    );
    expect(retry).toMatchObject({ addedKnowledgeIds: [], version: 1, eventId: null });
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:question_edit')),
    ).toHaveLength(1);
  });
});

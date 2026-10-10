import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { resetDb } from '../../../../../tests/helpers/db';
import {
  canonicalQuestionContentHash,
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

async function seedKnowledge(...ids: string[]) {
  const now = new Date();
  await db.insert(knowledge).values(
    ids.map((id) => ({
      id,
      name: id,
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved' as const,
      created_at: now,
      updated_at: now,
      version: 0,
    })),
  );
}

describe('findExactQuestionDuplicate', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('atomically appends missing KCs, preserves lifecycle, audits once, and no-ops on retry', async () => {
    await seedKnowledge('k-a', 'k-b');
    const hash = await seed('q-cross-kc', 'active', ['k-a']);
    const now = new Date('2026-07-19T11:00:00.000Z');

    const first = await db.transaction((tx) =>
      mergeExactQuestionDuplicateKnowledgeIds(tx, {
        canonicalContentHash: hash,
        knowledgeIds: ['k-a', 'k-b', 'k-b'],
        actorRef: 'quiz_gen',
        taskRunId: 'task-run-merge',
        now,
      }),
    );
    expect(first).toMatchObject({
      id: 'q-cross-kc',
      draftStatus: 'active',
      previousKnowledgeIds: ['k-a'],
      knowledgeIds: ['k-a', 'k-b'],
      addedKnowledgeIds: ['k-b'],
      enrolledKnowledgeIds: ['k-b'],
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
        enrolled_knowledge_ids: ['k-b'],
        task_run_id: 'task-run-merge',
        preserved_draft_status: 'active',
      },
    });
    const enrolled = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'k-b'));
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]).toMatchObject({
      subject_kind: 'knowledge',
      last_review_event_id: first?.eventId,
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

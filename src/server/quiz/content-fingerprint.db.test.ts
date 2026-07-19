import { db } from '@/db/client';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
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

  it('filters missing or archived incoming KCs inside the merge transaction', async () => {
    await seedKnowledge('k-live', 'k-archived');
    await db
      .update(knowledge)
      .set({ archived_at: new Date('2026-07-19T10:00:00.000Z') })
      .where(eq(knowledge.id, 'k-archived'));
    const hash = await seed('q-live-only', 'active', []);

    const result = await db.transaction((tx) =>
      mergeExactQuestionDuplicateKnowledgeIds(tx, {
        canonicalContentHash: hash,
        knowledgeIds: ['k-live', 'k-archived', 'k-missing'],
        actorRef: 'quiz_gen',
        now: new Date('2026-07-19T11:00:00.000Z'),
      }),
    );

    expect(result).toMatchObject({
      knowledgeIds: ['k-live'],
      addedKnowledgeIds: ['k-live'],
      enrolledKnowledgeIds: ['k-live'],
    });
  });

  it.each([
    ['quiz_gen', 'experimental:quiz_verify'],
    ['web_sourced', 'experimental:source_verify'],
  ] as const)(
    'releases the canonical hash of a terminal %s draft so fresh production can proceed',
    async (source, verifyAction) => {
      await seedKnowledge('k-new');
      const hash = await seed(`q-terminal-${source}`, 'draft', ['k-old']);
      await db
        .update(question)
        .set({ source })
        .where(eq(question.id, `q-terminal-${source}`));
      await db.insert(event).values({
        id: `verify-terminal-${source}`,
        actor_kind: 'agent',
        actor_ref: verifyAction,
        action: verifyAction,
        subject_kind: 'question',
        subject_id: `q-terminal-${source}`,
        outcome: 'failure',
        payload: {},
        created_at: new Date(),
      });

      const result = await db.transaction((tx) =>
        mergeExactQuestionDuplicateKnowledgeIds(tx, {
          canonicalContentHash: hash,
          knowledgeIds: ['k-new'],
          actorRef: 'quiz_gen',
          taskRunId: 'task-run-replace',
          now: new Date('2026-07-19T12:00:00.000Z'),
        }),
      );

      expect(result).toMatchObject({
        disposition: 'released_terminal_draft',
        addedKnowledgeIds: [],
        previousVersion: 0,
        version: 1,
      });
      const [released] = await db
        .select()
        .from(question)
        .where(eq(question.id, `q-terminal-${source}`));
      expect(released).toMatchObject({
        canonical_content_hash: null,
        knowledge_ids: ['k-old'],
        draft_status: 'draft',
        version: 1,
      });
      const [releaseEvent] = await db
        .select()
        .from(event)
        .where(eq(event.id, result?.eventId ?? ''));
      expect(releaseEvent.payload).toMatchObject({
        reason: 'terminal_draft_released_for_reproduction',
        terminal_verify_event_id: `verify-terminal-${source}`,
        task_run_id: 'task-run-replace',
      });
    },
  );
});

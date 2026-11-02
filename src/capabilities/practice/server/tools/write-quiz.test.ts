// ADR-0031 / YUK-304 (lane B) — write_quiz DomainTool (db partition).
//
// The load-bearing contrast (RP-2): DRAFT questions are ACCEPTED here (opposite
// precondition from write_review_plan) so a paper can include questions
// authored in the same copilot turn, pre-accept.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { artifact, question } from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import type { ToolContext } from '@/kernel/tools/types';
import { dismissAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { writeQuizTool } from './write-quiz';

const BASE = new Date('2026-06-09T00:00:00.000Z');

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_write_quiz',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
    ...overrides,
  };
}

async function seedQuestion(opts: {
  id: string;
  knowledgeIds?: string[];
  draft?: boolean;
  /** YUK-308 — non-copilot draft sources (e.g. 'quiz_gen' verify-failed). */
  source?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await testDb()
    .insert(question)
    .values({
      id: opts.id,
      kind: 'short_answer',
      prompt_md: `题面 ${opts.id}`,
      reference_md: '答案。',
      knowledge_ids: opts.knowledgeIds ?? ['k_a'],
      difficulty: 3,
      source: opts.source ?? (opts.draft ? 'copilot_authored' : 'manual'),
      draft_status: opts.draft ? 'draft' : null,
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      created_at: BASE,
      updated_at: BASE,
    });
}

describe('write_quiz DomainTool (ADR-0031 lane B)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Same window exercised end-to-end through the REAL dismiss applier: the two
  // paths serialize on the draft row lock, so exactly one ordering is observed.
  it('serializes against a real concurrent dismissAiProposal — write_quiz either wins or fails closed', async () => {
    const db = testDb();
    await seedQuestion({ id: 'q_live_race', draft: true });
    await writeAiProposal(db, {
      id: 'qd_live_race',
      actor_ref: 'agent:copilot',
      payload: {
        kind: 'question_draft',
        target: { subject_kind: 'question', subject_id: 'q_live_race' },
        reason_md: 'copilot 拟题（race）',
        evidence_refs: [],
        proposed_change: {
          question_id: 'q_live_race',
          kind: 'short_answer',
          difficulty: 3,
          knowledge_ids: ['k_a'],
          seed_mode: 'knowledge',
        },
      },
    });

    const [writeOutcome, dismissOutcome] = await Promise.all([
      writeQuizTool
        .execute(ctx({ taskRunId: 'tr_race_live' }), { question_ids: ['q_live_race'] })
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        ),
      dismissAiProposal(db, 'qd_live_race').then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ),
    ]);

    // The dismiss always completes: write_quiz's row lock only ever delays its
    // tombstone UPDATE (single-row wait, no lock cycle), and a paper committed
    // first does not gate it.
    expect(dismissOutcome.status).toBe('fulfilled');
    const [row] = await db.select().from(question).where(eq(question.id, 'q_live_race'));
    expect(row.metadata).toMatchObject({ dismissed_reason: 'question_draft_dismissed' });

    // Exactly one serialization won. If the tombstone committed (or was in
    // flight) at write_quiz's locked re-read, it fails closed with the
    // deterministic error and no paper exists. If write_quiz locked the row
    // first, the paper references a draft that was still live at that
    // instant — sequential-equivalent to a dismiss landing after the write
    // (pre-accept drafts in a paper are the designed semantics), and the
    // dismiss still commits its tombstone behind it.
    if (writeOutcome.status === 'rejected') {
      expect(String(writeOutcome.reason)).toMatch(/dismissed\/archived.*q_live_race/);
      expect(await db.select().from(artifact)).toHaveLength(0);
    } else {
      expect(writeOutcome.value.question_count).toBe(1);
      expect(await db.select().from(artifact)).toHaveLength(1);
    }
  });
});

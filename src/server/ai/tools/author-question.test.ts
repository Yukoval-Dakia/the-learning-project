import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorQuestion } from '@/capabilities/practice/server/tools/proposal-tools';
// ADR-0032 D8 — author_question unified question-authoring core + DomainTool.
//
// Proves the front door delegates to the EXISTING code paths without regressing
// the variant guards (HARD INVARIANT #1/#3) or the record_promotion accept
// idempotency (HARD INVARIANT #2):
//   - seed=variant   → practice-owned Failure Learning (guards preserved via delegation)
//   - seed=record    → kind:'record_promotion' / target:'question' → unchanged accept
//   - seed=knowledge|material → typed STUB, writes ZERO proposals (lane B seam)
//
// DB-config test: imports Failure Learning / writeAiProposal / acceptAiProposal /
// @/db, seeds a real Postgres testcontainer.
import { learning_record, question } from '@/db/schema';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const mockRunner = vi.hoisted(() => ({ runTask: vi.fn() }));
vi.mock('@/server/ai/runner', () => ({ runTask: mockRunner.runTask }));

const BASE = new Date('2026-06-09T00:00:00.000Z');

function deps() {
  return {
    db: testDb(),
    actorRef: 'agent:copilot',
    taskRunId: 'tr_author_question',
  };
}

async function seedRecord(id: string): Promise<void> {
  await testDb().insert(learning_record).values({
    id,
    kind: 'open_question',
    title: '之到底是什么',
    content_md: '总是把之误判成代词。',
    source: 'manual',
    capture_mode: 'text',
    activity_kind: 'ask',
    processing_status: 'raw',
    origin_event_id: null,
    subject_id: 'yuwen',
    knowledge_ids: [],
    question_id: null,
    attempt_event_id: null,
    learning_item_id: null,
    artifact_id: null,
    source_document_id: null,
    asset_refs: [],
    payload: {},
    created_at: BASE,
    updated_at: BASE,
  });
}

describe('author_question — record seed (record → question via record_promotion)', () => {
  beforeEach(async () => {
    await resetDb();
    mockRunner.runTask.mockReset();
  });

  it('the written proposal feeds the UNCHANGED accept path idempotently (HARD INVARIANT #2)', async () => {
    const db = testDb();
    await seedRecord('rec_open');
    const result = await authorQuestion(
      { seed_mode: 'record', record_id: 'rec_open', reasoning: 'Promote to a question.' },
      deps(),
    );
    const proposalId = result.proposal_ids[0];

    const accepted = await acceptAiProposal(db, proposalId, { user_note: 'ok' });
    expect(accepted.kind).toBe('record_promotion');
    const materializedId =
      accepted.kind === 'record_promotion' ? accepted.materialized_id : undefined;
    expect(materializedId).toBeTruthy();

    // A materialized question now exists.
    const questions = await db.select().from(question);
    expect(questions.map((q) => q.id)).toContain(materializedId);

    // Accept again → idempotent, no second question row.
    const again = await acceptAiProposal(db, proposalId, { user_note: 'ok again' });
    expect(again.kind).toBe('record_promotion');
    if (again.kind === 'record_promotion') {
      expect(again.idempotent).toBe(true);
      expect(again.materialized_id).toBe(materializedId);
    }
    const questionsAfter = await db.select().from(question);
    expect(questionsAfter).toHaveLength(questions.length);
  });
});

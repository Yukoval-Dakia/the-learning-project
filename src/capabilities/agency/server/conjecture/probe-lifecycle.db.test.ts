// Phase 0 关系脑 (YUK-406 / YUK-440) — U3 probe one-shot lifecycle DB test.
// Asserts the three load-bearing invariants of the A13 dark-loop producer:
//   1. POOL-INVISIBILITY / recurrence regression-lock — a served `mind_probe`
//      'draft' question NEVER surfaces in due-list.ts output, even when it carries
//      a failure attempt that would otherwise make it eligible for the
//      never-reviewed slice (this is what exercises the notDraftQuiz filter at
//      due-list.ts:438 — remove draft_status='draft' and this test goes red).
//   2. ≤3 concurrent active probes (MAX_CONCURRENT_ACTIVE_PROBES) + freeing on answer.
//   3. ND-5 — answering writes exactly ONE canonical experimental:probe_result
//      event and ZERO attempt events / ZERO FSRS rows.
// Plus the one-shot idempotency guard.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_CONCURRENT_ACTIVE_PROBES,
  PROBE_QUESTION_SOURCE,
  answerProbe,
  countActiveProbes,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { handleReviewDue } from '@/capabilities/practice/server/due-list';
import { newId } from '@/core/ids';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { writeAiProposal } from '@/server/proposals/writer';
import { resetDb, testDb } from '../../../../../tests/helpers/db';

const KC_ID = 'kn_chain_rule';
const PROBE_RESULT_ACTION = 'experimental:probe_result';

async function seedKnowledge(): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db
    .insert(knowledge)
    .values({ id: KC_ID, name: 'chain rule', created_at: now, updated_at: now })
    .onConflictDoNothing();
}

async function seedConjecture(): Promise<string> {
  const db = testDb();
  return writeAiProposal(db, {
    actor_ref: 'research_meeting',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: KC_ID },
      reason_md: 'recurrent cause×KC failure cell',
      evidence_refs: [{ kind: 'event', id: 'evt_a' }],
      cooldown_key: `conjecture:${KC_ID}`,
      proposed_change: {
        claim_md: 'you treat the chain rule as multiplying derivatives',
        knowledge_id: KC_ID,
        cause_category: 'concept_misunderstanding',
        confidence: 0.7,
        recurrence_count: 2,
        probe_md: 'd/dx sin(x^2) = ?',
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
}

async function serve(proposalId: string) {
  return serveProbeOnce({
    db: testDb(),
    conjectureProposalId: proposalId,
    knowledgeId: KC_ID,
    probeMd: 'd/dx sin(x^2) = ?',
    referenceMd: '2x·cos(x^2)',
  });
}

async function probeResultEvents(probeQuestionId: string) {
  const db = testDb();
  return db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, probeQuestionId),
      ),
    );
}

async function attemptEvents(probeQuestionId: string) {
  const db = testDb();
  return db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'attempt'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, probeQuestionId),
      ),
    );
}

async function fsrsRowCount(): Promise<number> {
  const db = testDb();
  const rows = await db.select().from(material_fsrs_state);
  return rows.length;
}

async function dueRows(): Promise<Array<{ id: string; question_id: string }>> {
  const res = await handleReviewDue(new Request('http://t/api/review/due'), {
    listActiveGoalsFn: async () => [],
  });
  const body = (await res.json()) as { rows: Array<{ id: string; question_id: string }> };
  return body.rows;
}

// Write a failure attempt directly on the probe so it becomes ELIGIBLE for the
// never-reviewed due slice — the only way to prove the draft filter (not the
// absence of an attempt) is what keeps the probe out of the pool.
async function seedFailureAttempt(probeQuestionId: string): Promise<void> {
  await writeEvent(testDb(), {
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: probeQuestionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [KC_ID],
    },
    created_at: new Date(),
  });
}

describe('probe one-shot lifecycle (U3)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedKnowledge();
  });

  it('serve materializes a draft mind_probe question carrying the conjecture ref', async () => {
    const proposalId = await seedConjecture();
    const result = await serve(proposalId);

    expect(result.status).toBe('served');
    if (result.status !== 'served') throw new Error('unreachable');
    expect(result.active_count).toBe(1);

    const [row] = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, result.probe_question_id));
    expect(row.source).toBe(PROBE_QUESTION_SOURCE);
    expect(row.draft_status).toBe('draft');
    expect(row.source_ref).toBe(proposalId);
    expect((row.metadata as Record<string, unknown>)?.conjecture_proposal_id).toBe(proposalId);
    expect(row.knowledge_ids).toEqual([KC_ID]);
    expect(await countActiveProbes(testDb())).toBe(1);
  });

  it('RECURRENCE REGRESSION-LOCK — a served mind_probe draft never appears in due-list, even with a failure attempt', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');

    // Make the probe eligible for the never-reviewed slice; the ONLY thing keeping
    // it out of the pool must be draft_status='draft' (due-list.ts:438 notDraftQuiz).
    await seedFailureAttempt(served.probe_question_id);

    const rows = await dueRows();
    expect(rows.some((r) => r.question_id === served.probe_question_id)).toBe(false);
    expect(rows.some((r) => r.id === served.probe_question_id)).toBe(false);
  });

  it('answer writes exactly one experimental:probe_result, NO attempt, NO FSRS row', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');

    const answered = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: 0,
      resolution: 'confirmed',
      answer_md: 'multiplies derivatives',
    });
    expect(answered.status).toBe('confirmed');
    expect(answered.idempotent).toBeUndefined();

    const results = await probeResultEvents(served.probe_question_id);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(answered.probe_result_event_id);
    expect(results[0].payload).toMatchObject({
      conjecture_event_id: proposalId,
      outcome: 0,
      resolution: 'confirmed',
      retrievability_at_judge: null,
      answer_md: 'multiplies derivatives',
    });
    expect(results[0].caused_by_event_id).toBe(proposalId);

    // ND-5 red line: no attempt event on the probe, no FSRS row anywhere.
    expect(await attemptEvents(served.probe_question_id)).toHaveLength(0);
    expect(await fsrsRowCount()).toBe(0);
    const fsrsForProbe = await testDb()
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, served.probe_question_id));
    expect(fsrsForProbe).toHaveLength(0);
    const fsrsForKc = await testDb()
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, KC_ID));
    expect(fsrsForKc).toHaveLength(0);

    // Answering frees the active slot.
    expect(await countActiveProbes(testDb())).toBe(0);
  });

  it('retire path records resolution=retired', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');

    const answered = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: 1,
      resolution: 'retired',
    });
    expect(answered.status).toBe('retired');

    const results = await probeResultEvents(served.probe_question_id);
    expect(results).toHaveLength(1);
    expect(results[0].payload).toMatchObject({ outcome: 1, resolution: 'retired' });
  });

  it('one-shot idempotency — answering twice writes only one probe_result event', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');

    const first = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: 0,
      resolution: 'confirmed',
    });
    const second = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: 1,
      resolution: 'retired',
    });

    expect(second.idempotent).toBe(true);
    // The recorded result (confirmed) wins — the second call did NOT overwrite it.
    expect(second.status).toBe('confirmed');
    expect(second.probe_result_event_id).toBe(first.probe_result_event_id);
    expect(await probeResultEvents(served.probe_question_id)).toHaveLength(1);
  });

  it('answer rejects an unknown question id with 404 probe_not_found', async () => {
    await expect(
      answerProbe({ db: testDb(), probeQuestionId: 'q_nope', outcome: 0, resolution: 'confirmed' }),
    ).rejects.toMatchObject({ code: 'probe_not_found', status: 404 });
  });

  it('answer rejects a non-probe question with 409 not_a_probe', async () => {
    const now = new Date();
    const qId = newId();
    // A regular (non mind_probe) question must not be answerable via this lifecycle.
    await testDb()
      .insert(question)
      .values({
        id: qId,
        kind: 'short_answer',
        prompt_md: 'regular question',
        reference_md: null,
        knowledge_ids: [KC_ID],
        difficulty: 3,
        source: 'manual',
        draft_status: 'active',
        metadata: {},
        created_at: now,
        updated_at: now,
      });
    await expect(
      answerProbe({ db: testDb(), probeQuestionId: qId, outcome: 0, resolution: 'confirmed' }),
    ).rejects.toMatchObject({ code: 'not_a_probe', status: 409 });
  });

  it('answer rejects a probe missing its conjecture ref with 409 probe_missing_conjecture_ref', async () => {
    const now = new Date();
    const qId = newId();
    // A mind_probe row whose metadata lacks conjecture_proposal_id (corrupt provenance).
    await testDb()
      .insert(question)
      .values({
        id: qId,
        kind: 'short_answer',
        prompt_md: 'orphan probe',
        reference_md: null,
        knowledge_ids: [KC_ID],
        difficulty: 3,
        source: PROBE_QUESTION_SOURCE,
        draft_status: 'draft',
        metadata: {},
        created_at: now,
        updated_at: now,
      });
    await expect(
      answerProbe({ db: testDb(), probeQuestionId: qId, outcome: 0, resolution: 'confirmed' }),
    ).rejects.toMatchObject({ code: 'probe_missing_conjecture_ref', status: 409 });
  });

  it('≤3 concurrent cap — 4th serve is cap_reached, answering frees a slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_ACTIVE_PROBES; i += 1) {
      const proposalId = await seedConjecture();
      const r = await serve(proposalId);
      expect(r.status).toBe('served');
      if (r.status === 'served') ids.push(r.probe_question_id);
    }
    expect(await countActiveProbes(testDb())).toBe(MAX_CONCURRENT_ACTIVE_PROBES);

    const proposal4 = await seedConjecture();
    const capped = await serve(proposal4);
    expect(capped.status).toBe('cap_reached');
    if (capped.status === 'cap_reached') {
      expect(capped.active_count).toBe(MAX_CONCURRENT_ACTIVE_PROBES);
    }
    // No new question row was written.
    const probeRows = await testDb()
      .select()
      .from(question)
      .where(eq(question.source, PROBE_QUESTION_SOURCE));
    expect(probeRows).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);

    // Answer one → active count drops → a new serve succeeds again.
    await answerProbe({
      db: testDb(),
      probeQuestionId: ids[0],
      outcome: 0,
      resolution: 'confirmed',
    });
    expect(await countActiveProbes(testDb())).toBe(MAX_CONCURRENT_ACTIVE_PROBES - 1);

    const proposal5 = await seedConjecture();
    const reopened = await serve(proposal5);
    expect(reopened.status).toBe('served');
  });
});

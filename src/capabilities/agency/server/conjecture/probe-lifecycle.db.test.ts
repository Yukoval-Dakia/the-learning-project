// Phase 0 关系脑 (YUK-406 / YUK-440) — U3 probe one-shot lifecycle DB test.
// Asserts the three load-bearing invariants of the A13 dark-loop producer:
//   1. POOL-INVISIBILITY / recurrence regression-lock — a served `mind_probe`
//      'draft' question NEVER surfaces in due-list.ts output, even when it carries
//      a failure attempt that would otherwise make it eligible for the
//      never-reviewed slice (this is what exercises the notDraftPredicate filter
//      in due-list.ts — remove draft_status='draft' and this test goes red).
//   2. ≤3 concurrent active probes (MAX_CONCURRENT_ACTIVE_PROBES) + freeing on answer.
//   3. ND-5 — answering writes exactly ONE canonical experimental:probe_result
//      event and ZERO attempt events / ZERO FSRS rows.
// Plus the one-shot idempotency guard.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { conjectureKey } from '@/capabilities/agency/server/conjecture/evidence';
import { loadConjectureHistory } from '@/capabilities/agency/server/conjecture/history';
import {
  MAX_CONCURRENT_ACTIVE_PROBES,
  PROBE_QUESTION_SOURCE,
  answerProbe,
  countActiveProbes,
  peekExistingProbeResult,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { handleReviewDue } from '@/capabilities/practice/server/due-list';
import { newId } from '@/core/ids';
import type { ConjectureProbeResponseJudgementT } from '@/core/schema/conjecture-probe-response';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/server/proposals/writer';
import { RESPONSE_AWARE_PROBE_FIELDS } from '../../../../../tests/helpers/conjecture-probe-fixtures';
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

async function seedConjecture({
  includeFollowup = true,
}: { includeFollowup?: boolean } = {}): Promise<string> {
  const db = testDb();
  const proposalId = await writeAiProposal(db, {
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
        probe_reference_md: '2x·cos(x^2) — outer cos × inner 2x (chain rule).',
        ...(includeFollowup
          ? {
              followup_probe_md: 'd/dx cos(x^3) = ?',
              followup_probe_reference_md: '-3x^2·sin(x^3) — outer -sin × inner 3x².',
            }
          : {}),
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
  await writeEvent(db, {
    id: `rate_${proposalId}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: { rating: 'accept', conjecture_id: proposalId, calibration_anchor: 'accept' },
    caused_by_event_id: proposalId,
  });
  return proposalId;
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

async function serveResponseAware(proposalId: string) {
  const referenceMd = '2x·cos(x^2) — outer cos × inner 2x (chain rule).';
  return serveProbeOnce({
    db: testDb(),
    conjectureProposalId: proposalId,
    knowledgeId: KC_ID,
    probeMd: 'd/dx sin(x^2) = ?',
    referenceMd,
    probeSpec: {
      ...RESPONSE_AWARE_PROBE_FIELDS,
      prompt_md: 'd/dx sin(x^2) = ?',
      reference_md: referenceMd,
      expected_target_error_answer_md: 'cos(x^2)+2x',
      elicits_target_error_reason_md: 'Distinguishes composition from addition.',
      context_kind: 'abstract',
      representation_kind: 'symbolic',
    },
  });
}

const GOLD_RESPONSE_JUDGEMENT = {
  rule_version: 'conjecture_probe_response_signature_v1',
  answer_result: 'correct',
  target_error_match: 'not_matched',
  gradable: true,
  reason_code: 'gold_signature_matched',
  signature_match_explanation_md: 'matches the gold response signature',
  evidence_refs: [
    'learner_response',
    'gold_response_signature',
    'target_error_response_signature',
    'correctness_judge',
  ],
} satisfies ConjectureProbeResponseJudgementT;

const TARGET_ERROR_RESPONSE_JUDGEMENT = {
  ...GOLD_RESPONSE_JUDGEMENT,
  answer_result: 'incorrect',
  target_error_match: 'matched',
  reason_code: 'target_error_signature_matched',
  signature_match_explanation_md: 'matches the target-error response signature',
} satisfies ConjectureProbeResponseJudgementT;

const ORDINARY_WRONG_RESPONSE_JUDGEMENT = {
  ...GOLD_RESPONSE_JUDGEMENT,
  answer_result: 'incorrect',
  target_error_match: 'not_matched',
  reason_code: 'response_matches_neither_signature',
  signature_match_explanation_md: 'matches neither authored response signature',
} satisfies ConjectureProbeResponseJudgementT;

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

async function probeQuestions(proposalId: string) {
  return testDb()
    .select()
    .from(question)
    .where(and(eq(question.source, PROBE_QUESTION_SOURCE), eq(question.source_ref, proposalId)));
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
    // it out of the pool must be draft_status='draft' (notDraftPredicate in due-list.ts).
    await seedFailureAttempt(served.probe_question_id);

    const rows = await dueRows();
    expect(rows.some((r) => r.question_id === served.probe_question_id)).toBe(false);
    expect(rows.some((r) => r.id === served.probe_question_id)).toBe(false);
  });

  it('first incorrect answer writes evidence_for, not confirmed, with no attempt or FSRS row', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');

    const answered = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: 0,
      answer_md: 'multiplies derivatives',
    });
    expect(answered.status).toBe('evidence_for');
    expect(answered.degradation_reason).toBe('probe_without_response_contract');
    expect(answered.idempotent).toBeUndefined();

    const results = await probeResultEvents(served.probe_question_id);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(answered.probe_result_event_id);
    expect(results[0].payload).toMatchObject({
      conjecture_event_id: proposalId,
      outcome: 0,
      resolution: 'evidence_for',
      resolution_rule_version: 'within_learner_probe_recurrence_v2',
      independent_probe_question_ids: [served.probe_question_id],
      retrievability_at_judge: null,
      answer_md: 'multiplies derivatives',
    });
    expect(results[0].caused_by_event_id).toBe(proposalId);
    // YUK-515: the internal probe outcome remains queryable by A13, but is born
    // opted out of the Mem0 outbox.
    expect(results[0].ingest_at).not.toBeNull();
    expect(results[0].affected_scopes).toEqual([]);

    // Deliberate contrast: a conjecture is an evidence-backed belief about the
    // learner, so its proposal remains eligible for memory ingestion.
    const [conjecture] = await testDb().select().from(event).where(eq(event.id, proposalId));
    expect(conjecture.ingest_at).toBeNull();

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

    // The matching first result atomically replaces its freed slot with the
    // independently authored follow-up; no dead confirmed rail.
    expect(await countActiveProbes(testDb())).toBe(1);
    const followups = (await probeQuestions(proposalId)).filter(
      (row) => (row.metadata as Record<string, unknown>).probe_sequence === 2,
    );
    expect(followups).toHaveLength(1);
    expect(followups[0]).toMatchObject({
      prompt_md: 'd/dx cos(x^3) = ?',
      reference_md: '-3x^2·sin(x^3) — outer -sin × inner 3x².',
      draft_status: 'draft',
    });
  });

  it.each([
    {
      label: 'missing judgement with target-error outcome',
      outcome: 0 as const,
      response_judgement: null,
    },
    {
      label: 'gold judgement with target-error outcome',
      outcome: 0 as const,
      response_judgement: GOLD_RESPONSE_JUDGEMENT,
    },
    {
      label: 'target-error judgement with correct outcome',
      outcome: 1 as const,
      response_judgement: TARGET_ERROR_RESPONSE_JUDGEMENT,
    },
    {
      label: 'target-error judgement with non-evidence outcome',
      outcome: null,
      response_judgement: TARGET_ERROR_RESPONSE_JUDGEMENT,
    },
  ])('rejects a fresh v2 persistence bypass: $label', async ({ outcome, response_judgement }) => {
    const proposalId = await seedConjecture();
    const served = await serveResponseAware(proposalId);
    if (served.status !== 'served') throw new Error('expected served response-aware probe');

    await expect(
      answerProbe({
        db: testDb(),
        probeQuestionId: served.probe_question_id,
        outcome,
        response_judgement,
      }),
    ).rejects.toMatchObject({ code: 'probe_response_judgement_mismatch', status: 409 });
    await expect(probeResultEvents(served.probe_question_id)).resolves.toHaveLength(0);
  });

  it('folds an ordinary wrong answer as terminal lifecycle history without treating it as evidence', async () => {
    const proposalId = await seedConjecture();
    const served = await serveResponseAware(proposalId);
    if (served.status !== 'served') throw new Error('expected served response-aware probe');
    const answeredAt = new Date('2026-07-29T00:00:00.000Z');

    const answered = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: null,
      response_judgement: ORDINARY_WRONG_RESPONSE_JUDGEMENT,
      now: answeredAt,
    });

    expect(answered.status).toBe('inconclusive');
    expect(answered.outcome).toBeNull();
    const key = conjectureKey('concept_misunderstanding', KC_ID);
    const history = await loadConjectureHistory(testDb(), [{ key, knowledge_id: KC_ID }]);
    expect(history.get(key)).toMatchObject({
      latest_decision: 'accept',
      latest_terminal_at: answeredAt,
      prior_claim_md: 'you treat the chain rule as multiplying derivatives',
    });
  });

  it('production follow-up path makes the second independent incorrect probe confirmed', async () => {
    const proposalId = await seedConjecture();
    const firstProbe = await serve(proposalId);
    if (firstProbe.status !== 'served') throw new Error('expected first served probe');

    const first = await answerProbe({
      db: testDb(),
      probeQuestionId: firstProbe.probe_question_id,
      outcome: 0,
    });
    const [secondProbe] = (await probeQuestions(proposalId)).filter(
      (row) => (row.metadata as Record<string, unknown>).probe_sequence === 2,
    );
    if (!secondProbe) throw new Error('expected automatic follow-up probe');
    const second = await answerProbe({
      db: testDb(),
      probeQuestionId: secondProbe.id,
      outcome: 0,
    });

    expect(first.status).toBe('evidence_for');
    expect(second.status).toBe('confirmed');
    expect((await probeResultEvents(firstProbe.probe_question_id))[0].payload).toMatchObject({
      resolution: 'evidence_for',
    });
    expect((await probeResultEvents(secondProbe.id))[0].payload).toMatchObject({
      resolution: 'confirmed',
      resolution_rule_version: 'within_learner_probe_recurrence_v2',
      independent_probe_question_ids: [firstProbe.probe_question_id, secondProbe.id].sort(),
    });
  });

  it('excludes corrected preliminary evidence and does not author a third probe', async () => {
    const proposalId = await seedConjecture();
    const firstProbe = await serve(proposalId);
    if (firstProbe.status !== 'served') throw new Error('expected first served probe');
    const first = await answerProbe({
      db: testDb(),
      probeQuestionId: firstProbe.probe_question_id,
      outcome: 0,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const [secondProbe] = (await probeQuestions(proposalId)).filter(
      (row) => (row.metadata as Record<string, unknown>).probe_sequence === 2,
    );
    if (!secondProbe) throw new Error('expected automatic follow-up probe');
    await writeEvent(testDb(), {
      id: `correct_${first.probe_result_event_id}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: first.probe_result_event_id,
      outcome: 'success',
      payload: {
        correction_kind: 'mark_wrong',
        reason_md: 'the preliminary probe evidence was invalid',
        affected_refs: [{ kind: 'open_inquiry', id: first.probe_result_event_id }],
      },
      created_at: new Date('2026-07-28T00:00:01.000Z'),
    });

    const second = await answerProbe({
      db: testDb(),
      probeQuestionId: secondProbe.id,
      outcome: 0,
      now: new Date('2026-07-28T00:00:02.000Z'),
    });

    expect(second.status).toBe('evidence_for');
    expect(await probeQuestions(proposalId)).toHaveLength(2);
    expect(await countActiveProbes(testDb())).toBe(0);
  });

  it('counts restored preliminary evidence toward recurrence confirmation', async () => {
    const proposalId = await seedConjecture();
    const firstProbe = await serve(proposalId);
    if (firstProbe.status !== 'served') throw new Error('expected first served probe');
    const first = await answerProbe({
      db: testDb(),
      probeQuestionId: firstProbe.probe_question_id,
      outcome: 0,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    const [secondProbe] = (await probeQuestions(proposalId)).filter(
      (row) => (row.metadata as Record<string, unknown>).probe_sequence === 2,
    );
    if (!secondProbe) throw new Error('expected automatic follow-up probe');
    for (const [index, correctionKind] of (['retract', 'restore'] as const).entries()) {
      await writeEvent(testDb(), {
        id: `${correctionKind}_${first.probe_result_event_id}`,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: first.probe_result_event_id,
        outcome: 'success',
        payload: {
          correction_kind: correctionKind,
          reason_md: `${correctionKind} preliminary evidence in test`,
          affected_refs: [{ kind: 'open_inquiry', id: first.probe_result_event_id }],
        },
        created_at: new Date(`2026-07-28T00:00:0${index + 1}.000Z`),
      });
    }

    const second = await answerProbe({
      db: testDb(),
      probeQuestionId: secondProbe.id,
      outcome: 0,
      now: new Date('2026-07-28T00:00:03.000Z'),
    });

    expect(second.status).toBe('confirmed');
  });

  it('serializes concurrent distinct answers so exactly one crosses the confirmation gate', async () => {
    const proposalId = await seedConjecture();
    const firstProbe = await serve(proposalId);
    const secondProbe = await serve(proposalId);
    if (firstProbe.status !== 'served' || secondProbe.status !== 'served') {
      throw new Error('expected two served probes');
    }

    const results = await Promise.all([
      answerProbe({
        db: testDb(),
        probeQuestionId: firstProbe.probe_question_id,
        outcome: 0,
      }),
      answerProbe({
        db: testDb(),
        probeQuestionId: secondProbe.probe_question_id,
        outcome: 0,
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['confirmed', 'evidence_for']);
  });

  it('folds all serialized history even when caller now predates the prior result timestamp', async () => {
    const proposalId = await seedConjecture();
    const firstProbe = await serve(proposalId);
    const secondProbe = await serve(proposalId);
    if (firstProbe.status !== 'served' || secondProbe.status !== 'served') {
      throw new Error('expected two served probes');
    }
    const earlier = new Date('2026-07-27T00:00:00.000Z');
    const later = new Date('2026-07-28T00:00:00.000Z');

    await answerProbe({
      db: testDb(),
      probeQuestionId: firstProbe.probe_question_id,
      outcome: 0,
      now: later,
    });
    const second = await answerProbe({
      db: testDb(),
      probeQuestionId: secondProbe.probe_question_id,
      outcome: 0,
      now: earlier,
    });

    expect(second.status).toBe('confirmed');
  });

  it('does not count a provenance-broken historical result toward confirmation', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');
    await writeEvent(testDb(), {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: PROBE_RESULT_ACTION,
      subject_kind: 'question',
      subject_id: 'prior_probe',
      payload: { conjecture_event_id: proposalId, outcome: 0, resolution: 'evidence_for' },
      caused_by_event_id: 'different_conjecture',
      created_at: new Date(),
    });

    const result = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: 0,
    });
    expect(result.status).toBe('evidence_for');
  });

  it('settles a legacy proposal with the historical rule so its active probe cannot strand a slot', async () => {
    const proposalId = await seedConjecture({ includeFollowup: false });
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');

    const result = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: 0,
    });

    expect(result.status).toBe('confirmed');
    const [persisted] = await probeResultEvents(served.probe_question_id);
    expect(persisted.payload).not.toHaveProperty('resolution_rule_version');
    expect(persisted.payload).not.toHaveProperty('independent_probe_question_ids');
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
    });
    expect(answered.status).toBe('retired');

    const results = await probeResultEvents(served.probe_question_id);
    expect(results).toHaveLength(1);
    expect(results[0].payload).toMatchObject({
      outcome: 1,
      independent_probe_question_ids: [],
    });
  });

  it('rejects a retracted conjecture without writing evidence or occupying a probe slot', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');

    await writeEvent(testDb(), {
      id: `correct_${proposalId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'owner retracted the conjecture before recurrence verification',
        affected_refs: [{ kind: 'open_inquiry', id: proposalId }],
      },
      caused_by_event_id: proposalId,
    });

    expect(await countActiveProbes(testDb())).toBe(0);
    await expect(
      answerProbe({
        db: testDb(),
        probeQuestionId: served.probe_question_id,
        outcome: 0,
      }),
    ).rejects.toMatchObject({ code: 'probe_conjecture_inactive', status: 409 });
    expect(await probeResultEvents(served.probe_question_id)).toHaveLength(0);
    expect(await probeQuestions(proposalId)).toHaveLength(1);
  });

  it('one-shot idempotency — answering twice writes only one probe_result event', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');

    const first = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: 0,
    });
    const second = await answerProbe({
      db: testDb(),
      probeQuestionId: served.probe_question_id,
      outcome: 1,
    });

    expect(second.idempotent).toBe(true);
    // The recorded preliminary result wins — the replay did NOT overwrite it.
    expect(second.status).toBe('evidence_for');
    expect(second.probe_result_event_id).toBe(first.probe_result_event_id);
    expect(await probeResultEvents(served.probe_question_id)).toHaveLength(1);
  });

  it('idempotent re-answer surfaces a corrupt recorded resolution instead of inventing one', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');

    // Simulate a corrupt prior probe_result (e.g. manual DB edit) with no valid
    // resolution. answerProbe must not reinterpret the corrupt history — it fails loud.
    await writeEvent(testDb(), {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: PROBE_RESULT_ACTION,
      subject_kind: 'question',
      subject_id: served.probe_question_id,
      payload: { conjecture_event_id: proposalId, outcome: 0 /* resolution missing */ },
      caused_by_event_id: proposalId,
      created_at: new Date(),
    });

    await expect(
      answerProbe({
        db: testDb(),
        probeQuestionId: served.probe_question_id,
        outcome: 1,
      }),
    ).rejects.toMatchObject({ code: 'probe_result_corrupt', status: 500 });
  });

  it('replays a legacy stored confirmed result without reinterpreting it as evidence_for', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');
    const resultId = newId();
    await writeEvent(testDb(), {
      id: resultId,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: PROBE_RESULT_ACTION,
      subject_kind: 'question',
      subject_id: served.probe_question_id,
      payload: { conjecture_event_id: proposalId, outcome: 0, resolution: 'confirmed' },
      caused_by_event_id: proposalId,
      created_at: new Date(),
    });

    await expect(peekExistingProbeResult(testDb(), served.probe_question_id)).resolves.toEqual({
      status: 'confirmed',
      outcome: 0,
      probe_result_event_id: resultId,
      response_judgement: null,
      degradation_reason: 'legacy_probe_result_without_response_judgement',
      idempotent: true,
    });
  });

  it('treats an explicit null response_judgement as legacy missing metadata', async () => {
    const proposalId = await seedConjecture();
    const served = await serve(proposalId);
    if (served.status !== 'served') throw new Error('expected served');
    const resultId = newId();
    await writeEvent(testDb(), {
      id: resultId,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: PROBE_RESULT_ACTION,
      subject_kind: 'question',
      subject_id: served.probe_question_id,
      payload: {
        conjecture_event_id: proposalId,
        outcome: 0,
        resolution: 'confirmed',
        response_judgement: null,
      },
      caused_by_event_id: proposalId,
      created_at: new Date(),
    });

    await expect(
      peekExistingProbeResult(testDb(), served.probe_question_id),
    ).resolves.toMatchObject({
      status: 'confirmed',
      outcome: 0,
      response_judgement: null,
      degradation_reason: 'legacy_probe_result_without_response_judgement',
      idempotent: true,
    });
  });

  it('answer rejects an unknown question id with 404 probe_not_found', async () => {
    await expect(
      answerProbe({ db: testDb(), probeQuestionId: 'q_nope', outcome: 0 }),
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
      answerProbe({ db: testDb(), probeQuestionId: qId, outcome: 0 }),
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
      answerProbe({ db: testDb(), probeQuestionId: qId, outcome: 0 }),
    ).rejects.toMatchObject({ code: 'probe_missing_conjecture_ref', status: 409 });
  });

  it('≤3 concurrent cap — preliminary follow-up keeps its slot while retirement frees one', async () => {
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

    // A first matching result consumes its newly freed slot with the required
    // follow-up, so ordinary probes cannot starve the recurrence gate.
    await answerProbe({
      db: testDb(),
      probeQuestionId: ids[0],
      outcome: 0,
    });
    expect(await countActiveProbes(testDb())).toBe(MAX_CONCURRENT_ACTIVE_PROBES);
    expect((await serve(await seedConjecture())).status).toBe('cap_reached');

    // A retired probe needs no follow-up and genuinely frees a slot.
    await answerProbe({
      db: testDb(),
      probeQuestionId: ids[1],
      outcome: 1,
    });
    expect(await countActiveProbes(testDb())).toBe(MAX_CONCURRENT_ACTIVE_PROBES - 1);
    const proposal5 = await seedConjecture();
    const reopened = await serve(proposal5);
    expect(reopened.status).toBe('served');
  });
});

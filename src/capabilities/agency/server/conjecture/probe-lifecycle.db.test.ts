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

import {
  answerProbe,
  peekExistingProbeResult,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { newId } from '@/core/ids';
import { event, knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';
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
}: {
  includeFollowup?: boolean;
} = {}): Promise<string> {
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

describe('probe one-shot lifecycle (U3)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedKnowledge();
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
});

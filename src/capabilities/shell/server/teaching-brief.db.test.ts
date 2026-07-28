// YUK-706 (P0F/2) — TeachingBrief read model DB contract.
//
// Locks the projected states, global precedence, TTLs, full P→Q→R provenance
// validation, corrupt-row fail-closed behavior, anti-guilt wire, and the zero-write
// boundary. The read model deliberately does not depend on overnight-digest or the
// downstream prediction_score reconcile loop.

import {
  answerProbe,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { TeachingBriefResponseSchema } from '@/capabilities/shell/api/contracts';
import { shellCapability } from '@/capabilities/shell/manifest';
import {
  TEACHING_BRIEF_CANDIDATE_WINDOW,
  TEACHING_BRIEF_FINDING_TTL_MS,
  TEACHING_BRIEF_OUTCOME_TTL_MS,
  loadTeachingBrief,
} from '@/capabilities/shell/server/teaching-brief';
import { acknowledgeTeachingBriefOutcome } from '@/capabilities/shell/server/teaching-brief-ack';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, count, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const NOW = new Date('2026-07-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function rawProposalRow(opts: {
  id: string;
  createdAt: Date;
  confidence?: number;
  recurrenceCount?: number;
}): typeof event.$inferInsert {
  const knowledgeId = `kn_${opts.id}`;
  return {
    id: opts.id,
    actor_kind: 'agent',
    actor_ref: 'research_meeting',
    action: 'experimental:proposal',
    subject_kind: 'mind_model',
    subject_id: knowledgeId,
    outcome: 'partial',
    payload: {
      ai_proposal: {
        kind: 'conjecture',
        target: { subject_kind: 'mind_model', subject_id: knowledgeId },
        reason_md: `basis for ${opts.id}`,
        evidence_refs: [{ kind: 'event', id: `evt_evidence_${opts.id}` }],
        cooldown_key: `conjecture:${opts.id}`,
        proposed_change: {
          claim_md: `claim for ${opts.id}`,
          knowledge_id: knowledgeId,
          cause_category: 'concept_misunderstanding',
          confidence: opts.confidence ?? 0.5,
          recurrence_count: opts.recurrenceCount ?? 2,
          probe_md: `probe for ${opts.id}`,
          probe_reference_md: `reference for ${opts.id}`,
          discriminating: true,
          corrected_by_owner: false,
          predicted_p: 0.3,
          baseline_p_at_induction: 0.6,
        },
      },
    },
    created_at: opts.createdAt,
  };
}

function rawAcceptRateRow(proposalId: string, createdAt: Date): typeof event.$inferInsert {
  return {
    id: `rate_${proposalId}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: { rating: 'accept', conjecture_id: proposalId },
    caused_by_event_id: proposalId,
    created_at: createdAt,
  };
}

function rawDismissRateRow(proposalId: string, createdAt: Date): typeof event.$inferInsert {
  return {
    ...rawAcceptRateRow(proposalId, createdAt),
    payload: { rating: 'dismiss', conjecture_id: proposalId },
  };
}

function selectCountingDb(base: Db): { db: Db; selectCount: () => number } {
  let count = 0;
  const counting = new Proxy(base, {
    get(target, property) {
      if (property === 'select') {
        return (...args: unknown[]) => {
          count += 1;
          return (target.select as (...selectArgs: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Db;
  return { db: counting, selectCount: () => count };
}

interface ProposalSeed {
  id: string;
  createdAt: Date;
  claim?: string;
  reason?: string;
  knowledgeId?: string;
  confidence?: number;
  recurrenceCount?: number;
  evidence?: Array<{ kind: 'event' | 'question'; id: string }>;
  predictedP?: number;
  baselineP?: number;
  followupProbeMd?: string;
  followupProbeReferenceMd?: string;
}

async function seedProposal(seed: ProposalSeed): Promise<string> {
  const claim = seed.claim ?? `claim for ${seed.id}`;
  const knowledgeId = seed.knowledgeId ?? `kn_${seed.id}`;
  return writeAiProposal(testDb(), {
    id: seed.id,
    actor_ref: 'research_meeting',
    created_at: seed.createdAt,
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: knowledgeId },
      reason_md: seed.reason ?? `basis for ${seed.id}`,
      evidence_refs: seed.evidence ?? [
        { kind: 'event', id: `evt_evidence_${seed.id}` },
        { kind: 'question', id: `q_evidence_${seed.id}` },
      ],
      cooldown_key: `conjecture:${seed.id}`,
      proposed_change: {
        claim_md: claim,
        knowledge_id: knowledgeId,
        cause_category: 'concept_misunderstanding',
        confidence: seed.confidence ?? 0.7,
        recurrence_count: seed.recurrenceCount ?? 2,
        probe_md: `probe for ${seed.id}`,
        probe_reference_md: `reference for ${seed.id}`,
        ...(seed.followupProbeMd !== undefined && seed.followupProbeReferenceMd !== undefined
          ? {
              followup_probe_md: seed.followupProbeMd,
              followup_probe_reference_md: seed.followupProbeReferenceMd,
            }
          : {}),
        discriminating: true,
        predicted_p: seed.predictedP ?? 0.3,
        baseline_p_at_induction: seed.baselineP ?? 0.6,
      },
    },
  });
}

async function acceptProposal(
  proposalId: string,
  createdAt: Date,
  correctedClaim?: string,
): Promise<void> {
  await writeEvent(testDb(), {
    id: `rate_${proposalId}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: {
      rating: 'accept',
      conjecture_id: proposalId,
      corrected_by_owner: correctedClaim !== undefined,
      calibration_anchor: correctedClaim === undefined ? 'accept' : 'edit',
      ...(correctedClaim ? { corrected_claim_md: correctedClaim } : {}),
    },
    caused_by_event_id: proposalId,
    created_at: createdAt,
  });
}

async function seedProbe(opts: {
  proposalId: string;
  knowledgeId?: string;
  createdAt: Date;
  promptMd?: string;
  referenceMd?: string;
  probeSequence?: 1 | 2;
}): Promise<string> {
  const served = await serveProbeOnce({
    db: testDb(),
    conjectureProposalId: opts.proposalId,
    knowledgeId: opts.knowledgeId ?? `kn_${opts.proposalId}`,
    probeMd: opts.promptMd ?? `probe for ${opts.proposalId}`,
    referenceMd: opts.referenceMd ?? `reference for ${opts.proposalId}`,
    probeSequence: opts.probeSequence,
    now: opts.createdAt,
  });
  if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);
  return served.probe_question_id;
}

async function seedAcceptedProbe(opts: {
  proposalId: string;
  proposalAt: Date;
  probeAt: Date;
  correctedClaim?: string;
}): Promise<string> {
  await seedProposal({ id: opts.proposalId, createdAt: opts.proposalAt });
  await acceptProposal(opts.proposalId, opts.probeAt, opts.correctedClaim);
  return seedProbe({ proposalId: opts.proposalId, createdAt: opts.probeAt });
}

async function seedOutcome(opts: {
  proposalId: string;
  proposalAt: Date;
  probeAt: Date;
  resultAt: Date;
  resolution?: 'evidence_for' | 'confirmed' | 'retired';
}): Promise<{ probeId: string; resultId: string }> {
  const probeId = await seedAcceptedProbe({
    proposalId: opts.proposalId,
    proposalAt: opts.proposalAt,
    probeAt: opts.probeAt,
  });
  const resolution = opts.resolution ?? 'confirmed';
  const resultId = `result_${opts.proposalId}`;
  // Reader fixture: write the persisted resolution verbatim so legacy confirmed
  // events remain covered without asking the new writer to bypass its n=1 gate.
  await writeEvent(testDb(), {
    id: resultId,
    actor_kind: 'system',
    actor_ref: 'mind_probe',
    action: 'experimental:probe_result',
    subject_kind: 'question',
    subject_id: probeId,
    payload: {
      conjecture_event_id: opts.proposalId,
      outcome: resolution === 'retired' ? 1 : 0,
      resolution,
      retrievability_at_judge: 0.413579,
      answer_md: null,
      answer_image_refs: [],
    },
    caused_by_event_id: opts.proposalId,
    ingest_at: opts.resultAt,
    created_at: opts.resultAt,
  });
  return { probeId, resultId };
}

async function tableCounts(): Promise<{ events: number; questions: number }> {
  const [events] = await testDb().select({ n: count() }).from(event);
  const [questions] = await testDb().select({ n: count() }).from(question);
  return { events: events?.n ?? 0, questions: questions?.n ?? 0 };
}

describe('loadTeachingBrief', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('projects a fresh pending conjecture as finding', async () => {
    const proposedAt = new Date(NOW.getTime() - DAY_MS);
    await seedProposal({ id: 'p_finding', createdAt: proposedAt });

    const result = await loadTeachingBrief(testDb(), NOW);
    expect(() => TeachingBriefResponseSchema.parse(result)).not.toThrow();
    expect(result.brief).toMatchObject({
      brief_id: 'p_finding',
      state: 'finding',
      updated_at: proposedAt.toISOString(),
      expires_at: new Date(proposedAt.getTime() + TEACHING_BRIEF_FINDING_TTL_MS).toISOString(),
      finding: {
        claim_md: 'claim for p_finding',
        knowledge_id: 'kn_p_finding',
        cause_category: 'concept_misunderstanding',
      },
      basis: {
        summary_md: 'basis for p_finding',
        evidence_trace: [
          { role: 'induction', kind: 'event', id: 'evt_evidence_p_finding' },
          { role: 'induction', kind: 'question', id: 'q_evidence_p_finding' },
        ],
      },
      prepared_action: {
        kind: 'review_finding',
        proposal_id: 'p_finding',
        probe_preview_md: 'probe for p_finding',
      },
      current_outcome: {
        status: 'awaiting_decision',
        summary_md: '这仍是一条待检验的判断。',
      },
    });
  });

  it('projects a served unanswered probe and honours the corrected claim from accept rate', async () => {
    const probeAt = new Date(NOW.getTime() - 30 * 60 * 1000);
    const probeId = await seedAcceptedProbe({
      proposalId: 'p_probe',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt,
      correctedClaim: 'owner-corrected claim',
    });

    const { brief } = await loadTeachingBrief(testDb(), NOW);
    expect(brief).toMatchObject({
      brief_id: 'p_probe',
      state: 'probe_ready',
      updated_at: probeAt.toISOString(),
      expires_at: null,
      // YUK-785 — the owner's words stay primary, and the brief additionally discloses
      // that the prepared probe belongs to the pre-edit claim.
      finding: { claim_md: 'owner-corrected claim', tested_claim_md: 'claim for p_probe' },
      basis: {
        evidence_trace: [
          { role: 'induction', kind: 'event', id: 'evt_evidence_p_probe' },
          { role: 'induction', kind: 'question', id: 'q_evidence_p_probe' },
          { role: 'probe', kind: 'question', id: probeId },
        ],
      },
      prepared_action: {
        kind: 'answer_probe',
        probe_question_id: probeId,
        prompt_md: 'probe for p_probe',
      },
      current_outcome: {
        status: 'awaiting_answer',
        summary_md: '判别题针对的是你改写前的那条判断；你的改写还没有配套的判别题。',
      },
    });
  });

  it('projects and acknowledges a confirmed sequence-2 probe against its authored follow-up prompt', async () => {
    const proposalId = 'p_followup';
    const followupPrompt = 'independent follow-up for p_followup';
    const followupReference = 'reference for independent follow-up';
    await seedProposal({
      id: proposalId,
      createdAt: new Date(NOW.getTime() - DAY_MS),
      followupProbeMd: followupPrompt,
      followupProbeReferenceMd: followupReference,
    });
    await acceptProposal(proposalId, new Date(NOW.getTime() - 30 * 60 * 1000));
    const firstProbeId = await seedProbe({
      proposalId,
      createdAt: new Date(NOW.getTime() - 25 * 60 * 1000),
    });
    const first = await answerProbe({
      db: testDb(),
      probeQuestionId: firstProbeId,
      outcome: 0,
      now: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    expect(first.status).toBe('evidence_for');
    const followups = await testDb()
      .select()
      .from(question)
      .where(eq(question.source_ref, proposalId));
    const followup = followups.find(
      (row) => (row.metadata as Record<string, unknown>).probe_sequence === 2,
    );
    if (!followup) throw new Error('expected the preliminary result to activate a follow-up');
    expect(followup.prompt_md).toBe(followupPrompt);

    // Deliberately backdate the terminal result. Supersession follows the persisted
    // recurrence rule stamp, not wall-clock order.
    const terminal = await answerProbe({
      db: testDb(),
      probeQuestionId: followup.id,
      outcome: 0,
      now: new Date(NOW.getTime() - 20 * 60 * 1000),
    });
    expect(terminal.status).toBe('confirmed');

    const settled = await loadTeachingBrief(testDb(), NOW);
    expect(settled.brief).toMatchObject({
      brief_id: proposalId,
      state: 'outcome_confirmed',
      current_outcome: {
        probe_question_id: followup.id,
        probe_result_event_id: terminal.probe_result_event_id,
      },
    });
    await acknowledgeTeachingBriefOutcome(testDb(), terminal.probe_result_event_id, NOW);
    // The terminal result supersedes the older preliminary result. Acknowledging the
    // terminal must close the brief rather than regress it to "needs revalidation".
    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toEqual({ brief: null });
  });

  it('does not let an invalid terminal chain suppress valid preliminary evidence', async () => {
    const proposalId = 'p_invalid_terminal_chain';
    await seedProposal({
      id: proposalId,
      createdAt: new Date(NOW.getTime() - DAY_MS),
      followupProbeMd: 'independent follow-up',
      followupProbeReferenceMd: 'independent reference',
    });
    await acceptProposal(proposalId, new Date(NOW.getTime() - 30 * 60 * 1000));
    const firstProbeId = await seedProbe({
      proposalId,
      createdAt: new Date(NOW.getTime() - 25 * 60 * 1000),
    });
    const first = await answerProbe({
      db: testDb(),
      probeQuestionId: firstProbeId,
      outcome: 0,
      now: new Date(NOW.getTime() - 20 * 60 * 1000),
    });
    const followup = (
      await testDb().select().from(question).where(eq(question.source_ref, proposalId))
    ).find((row) => (row.metadata as Record<string, unknown>).probe_sequence === 2);
    if (!followup) throw new Error('expected recurrence probe');
    await answerProbe({
      db: testDb(),
      probeQuestionId: followup.id,
      outcome: 0,
      now: new Date(NOW.getTime() - 10 * 60 * 1000),
    });

    // Simulate a corrupted/mutated question chain after the terminal event was
    // appended. The canonical terminal payload must not hide the still-valid
    // preliminary result when its authored prompt no longer matches.
    await testDb()
      .update(question)
      .set({ prompt_md: 'drifted follow-up prompt' })
      .where(eq(question.id, followup.id));

    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toMatchObject({
      brief: {
        brief_id: proposalId,
        state: 'outcome_evidence_for',
        current_outcome: {
          probe_result_event_id: first.probe_result_event_id,
          status: 'evidence_for',
        },
      },
    });
  });

  it('hides a recurrence outcome when its preliminary evidence is corrected, then restores it', async () => {
    const proposalId = 'p_corrected_dependency';
    await seedProposal({
      id: proposalId,
      createdAt: new Date(NOW.getTime() - DAY_MS),
      followupProbeMd: 'independent follow-up',
      followupProbeReferenceMd: 'independent reference',
    });
    await acceptProposal(proposalId, new Date(NOW.getTime() - 30 * 60 * 1000));
    const firstProbeId = await seedProbe({
      proposalId,
      createdAt: new Date(NOW.getTime() - 25 * 60 * 1000),
    });
    const first = await answerProbe({
      db: testDb(),
      probeQuestionId: firstProbeId,
      outcome: 0,
      now: new Date(NOW.getTime() - 20 * 60 * 1000),
    });
    const followup = (
      await testDb().select().from(question).where(eq(question.source_ref, proposalId))
    ).find((row) => (row.metadata as Record<string, unknown>).probe_sequence === 2);
    if (!followup) throw new Error('expected recurrence probe');
    const terminal = await answerProbe({
      db: testDb(),
      probeQuestionId: followup.id,
      outcome: 0,
      now: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toMatchObject({
      brief: {
        state: 'outcome_confirmed',
        current_outcome: { probe_result_event_id: terminal.probe_result_event_id },
      },
    });

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
        reason_md: 'preliminary evidence invalidated',
        affected_refs: [{ kind: 'open_inquiry', id: first.probe_result_event_id }],
      },
      created_at: new Date(NOW.getTime() - 5 * 60 * 1000),
    });
    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toEqual({ brief: null });

    await writeEvent(testDb(), {
      id: `restore_${first.probe_result_event_id}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: first.probe_result_event_id,
      outcome: 'success',
      payload: {
        correction_kind: 'restore',
        reason_md: 'preliminary evidence revalidated',
        affected_refs: [{ kind: 'open_inquiry', id: first.probe_result_event_id }],
      },
      created_at: new Date(NOW.getTime() - 4 * 60 * 1000),
    });
    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toMatchObject({
      brief: {
        state: 'outcome_confirmed',
        current_outcome: { probe_result_event_id: terminal.probe_result_event_id },
      },
    });
  });

  it('does not display a corrected outcome and restores it on a later restore event', async () => {
    const seeded = await seedOutcome({
      proposalId: 'p_corrected_outcome',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      resultAt: new Date(NOW.getTime() - 30 * 60 * 1000),
    });
    await writeEvent(testDb(), {
      id: `correct_${seeded.resultId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: seeded.resultId,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'outcome invalidated',
        affected_refs: [{ kind: 'open_inquiry', id: seeded.resultId }],
      },
      created_at: new Date(NOW.getTime() - 20 * 60 * 1000),
    });
    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toEqual({ brief: null });

    await writeEvent(testDb(), {
      id: `restore_${seeded.resultId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: seeded.resultId,
      outcome: 'success',
      payload: {
        correction_kind: 'restore',
        reason_md: 'outcome revalidated',
        affected_refs: [{ kind: 'open_inquiry', id: seeded.resultId }],
      },
      created_at: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toMatchObject({
      brief: {
        state: 'outcome_confirmed',
        current_outcome: { probe_result_event_id: seeded.resultId },
      },
    });
  });

  it.each([
    [
      'evidence_for',
      'outcome_evidence_for',
      '这次表现与这条判断一致，但单次探针不足以下结论；还需要一次独立复验。',
    ],
    ['confirmed', 'outcome_confirmed', '这条判断得到这次探针的支持；下一步可以针对这个点练习。'],
    ['retired', 'outcome_retired', '这条判断被这次探针排除；原计划可以继续。'],
  ] as const)('projects %s probe result as %s', async (resolution, state, summary) => {
    const resultAt = new Date(NOW.getTime() - 10 * 60 * 1000);
    const { probeId, resultId } = await seedOutcome({
      proposalId: `p_${resolution}`,
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt: new Date(NOW.getTime() - 20 * 60 * 1000),
      resultAt,
      resolution,
    });

    const warn =
      resolution === 'evidence_for' ? vi.spyOn(console, 'warn').mockImplementation(() => {}) : null;
    const response = await loadTeachingBrief(testDb(), NOW);
    expect(() => TeachingBriefResponseSchema.parse(response)).not.toThrow();
    // YUK-708/709 — confirmed offers KC-scoped practice (knowledge_id === proposal KC);
    // retired offers only the acknowledge (dismiss). Both target this result for the ack.
    const expectedPreparedAction =
      state === 'outcome_confirmed'
        ? {
            kind: 'practice_scoped',
            knowledge_id: `kn_p_${resolution}`,
            probe_result_event_id: resultId,
          }
        : { kind: 'acknowledge_outcome', probe_result_event_id: resultId };
    expect(response.brief).toMatchObject({
      brief_id: `p_${resolution}`,
      state,
      updated_at: resultAt.toISOString(),
      expires_at: new Date(resultAt.getTime() + TEACHING_BRIEF_OUTCOME_TTL_MS).toISOString(),
      prepared_action: expectedPreparedAction,
      current_outcome: {
        status: resolution,
        summary_md: summary,
        probe_question_id: probeId,
        probe_result_event_id: resultId,
      },
    });
    expect(response.brief?.basis.evidence_trace.at(-2)).toEqual({
      role: 'probe',
      kind: 'question',
      id: probeId,
    });
    expect(response.brief?.basis.evidence_trace.at(-1)).toEqual({
      role: 'outcome',
      kind: 'event',
      id: resultId,
    });
    if (resolution === 'evidence_for') {
      expect(summary).not.toContain('得到支持');
      expect(summary).not.toContain('确证');
      expect(warn).not.toHaveBeenCalledWith(
        '[teaching-brief] skipped candidate',
        expect.objectContaining({ reason: 'outcome_resolution_mismatch' }),
      );
    }
    warn?.mockRestore();
  });

  it('applies global precedence outcome > active probe > pending finding', async () => {
    await seedOutcome({
      proposalId: 'p_outcome',
      proposalAt: new Date(NOW.getTime() - 3 * DAY_MS),
      probeAt: new Date(NOW.getTime() - 2 * DAY_MS),
      resultAt: new Date(NOW.getTime() - DAY_MS),
      resolution: 'retired',
    });
    await seedAcceptedProbe({
      proposalId: 'p_active',
      proposalAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      probeAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    await seedProposal({
      id: 'p_new_finding',
      createdAt: new Date(NOW.getTime() - 10 * 60 * 1000),
      confidence: 1,
      recurrenceCount: 10,
    });

    const { brief } = await loadTeachingBrief(testDb(), NOW);
    expect(brief).toMatchObject({ brief_id: 'p_outcome', state: 'outcome_retired' });
  });

  it('drops an acknowledged outcome and selects the next candidate (YUK-708)', async () => {
    const acked = await seedOutcome({
      proposalId: 'p_acked',
      proposalAt: new Date(NOW.getTime() - 3 * DAY_MS),
      probeAt: new Date(NOW.getTime() - 2 * DAY_MS),
      resultAt: new Date(NOW.getTime() - 30 * 60 * 1000),
    });
    // A still-active probe sits behind the outcome; once the outcome is acked, the
    // probe is the next globally-preferred candidate (outcome > probe > finding).
    const activeProbe = await seedAcceptedProbe({
      proposalId: 'p_next_probe',
      proposalAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      probeAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    const before = await loadTeachingBrief(testDb(), NOW);
    expect(before.brief).toMatchObject({ brief_id: 'p_acked', state: 'outcome_confirmed' });

    await acknowledgeTeachingBriefOutcome(testDb(), acked.resultId, NOW);

    const after = await loadTeachingBrief(testDb(), NOW);
    expect(after.brief).toMatchObject({ brief_id: 'p_next_probe', state: 'probe_ready' });
    expect(after.brief?.prepared_action).toMatchObject({ probe_question_id: activeProbe });
  });

  it('returns quiet null once the sole outcome is acknowledged', async () => {
    const { resultId } = await seedOutcome({
      proposalId: 'p_sole',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      resultAt: new Date(NOW.getTime() - 30 * 60 * 1000),
    });
    await acknowledgeTeachingBriefOutcome(testDb(), resultId, NOW);

    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toEqual({ brief: null });
  });

  it('does not let a burst of acked outcomes evict an older un-acked valid outcome', async () => {
    const survivor = await seedOutcome({
      proposalId: 'p_unacked_survivor',
      proposalAt: new Date(NOW.getTime() - 3 * DAY_MS),
      probeAt: new Date(NOW.getTime() - 2 * DAY_MS),
      resultAt: new Date(NOW.getTime() - DAY_MS),
    });
    // A window's worth of NEWER outcomes, each acknowledged. Excluded pre-window, they
    // must not crowd the older un-acked survivor out of the bounded candidate set.
    for (let i = 0; i < TEACHING_BRIEF_CANDIDATE_WINDOW; i += 1) {
      const { resultId } = await seedOutcome({
        proposalId: `p_acked_burst_${String(i).padStart(2, '0')}`,
        proposalAt: new Date(NOW.getTime() - 3 * DAY_MS),
        probeAt: new Date(NOW.getTime() - 2 * DAY_MS),
        resultAt: new Date(NOW.getTime() - (TEACHING_BRIEF_CANDIDATE_WINDOW - i) * 60_000),
        resolution: 'confirmed',
      });
      await acknowledgeTeachingBriefOutcome(testDb(), resultId, NOW);
    }

    const result = await loadTeachingBrief(testDb(), NOW);
    expect(result.brief).toMatchObject({
      brief_id: 'p_unacked_survivor',
      state: 'outcome_confirmed',
    });
    expect(result.brief?.current_outcome).toMatchObject({
      probe_result_event_id: survivor.resultId,
    });
  });

  it('drops expired outcomes, keeps probes clock-invariant, and uses salience with deterministic finding ties', async () => {
    await seedOutcome({
      proposalId: 'p_expired_outcome',
      proposalAt: new Date(NOW.getTime() - 10 * DAY_MS),
      probeAt: new Date(NOW.getTime() - 9 * DAY_MS),
      resultAt: new Date(NOW.getTime() - TEACHING_BRIEF_OUTCOME_TTL_MS),
    });
    await seedAcceptedProbe({
      proposalId: 'p_old_active',
      proposalAt: new Date(NOW.getTime() - 20 * DAY_MS),
      probeAt: new Date(NOW.getTime() - 19 * DAY_MS),
    });
    await seedProposal({
      id: 'p_find_a',
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      confidence: 0.5,
      recurrenceCount: 4,
    });
    await seedProposal({
      id: 'p_find_z',
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      confidence: 1,
      recurrenceCount: 2,
    });

    const first = await loadTeachingBrief(testDb(), NOW);
    expect(first.brief).toMatchObject({ brief_id: 'p_old_active', state: 'probe_ready' });

    const [activeQuestion] = await testDb()
      .select({ id: question.id })
      .from(question)
      .where(eq(question.source_ref, 'p_old_active'));
    if (!activeQuestion) throw new Error('expected p_old_active question');
    await answerProbe({
      db: testDb(),
      probeQuestionId: activeQuestion.id,
      outcome: 1,
      now: new Date(NOW.getTime() - TEACHING_BRIEF_OUTCOME_TTL_MS),
    });

    const second = await loadTeachingBrief(testDb(), NOW);
    expect(second.brief).toMatchObject({ brief_id: 'p_find_z', state: 'finding' });
  });

  it('skips a newer orphan result with an observable reason and selects the next sound outcome', async () => {
    const valid = await seedOutcome({
      proposalId: 'p_valid',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      resultAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    await writeEvent(testDb(), {
      id: 'r_orphan_newer',
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: 'experimental:probe_result',
      subject_kind: 'question',
      subject_id: 'q_missing',
      payload: { conjecture_event_id: 'p_missing', outcome: 0, resolution: 'confirmed' },
      caused_by_event_id: 'p_missing',
      created_at: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { brief } = await loadTeachingBrief(testDb(), NOW);

    expect(brief).toMatchObject({ brief_id: 'p_valid', state: 'outcome_confirmed' });
    expect(brief?.current_outcome).toMatchObject({ probe_result_event_id: valid.resultId });
    expect(warn).toHaveBeenCalledWith(
      '[teaching-brief] skipped candidate',
      expect.objectContaining({
        stage: 'outcome',
        candidate_id: 'r_orphan_newer',
        reason: 'probe_not_found',
      }),
    );
    warn.mockRestore();
  });

  it('fails closed on an empty-evidence finding and returns calm null', async () => {
    await seedProposal({
      id: 'p_no_evidence',
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      evidence: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await loadTeachingBrief(testDb(), NOW);

    expect(result).toEqual({ brief: null });
    expect(warn).toHaveBeenCalledWith(
      '[teaching-brief] skipped candidate',
      expect.objectContaining({
        stage: 'finding',
        candidate_id: 'p_no_evidence',
        reason: 'induction_evidence_missing',
      }),
    );
    warn.mockRestore();
  });

  it('logs a malformed fresh conjecture payload and continues to a sound finding', async () => {
    await seedProposal({
      id: 'p_sound_after_bad',
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    });
    await testDb()
      .insert(event)
      .values({
        id: 'p_malformed_newer',
        actor_kind: 'agent',
        actor_ref: 'research_meeting',
        action: 'experimental:proposal',
        subject_kind: 'mind_model',
        subject_id: 'kn_malformed',
        outcome: 'partial',
        payload: {
          ai_proposal: {
            kind: 'conjecture',
            target: { subject_kind: 'mind_model', subject_id: 'kn_malformed' },
            reason_md: 'not emitted',
            evidence_refs: [{ kind: 'event', id: 'evt_bad' }],
            proposed_change: { claim_md: '' },
          },
        },
        created_at: new Date(NOW.getTime() - 60 * 60 * 1000),
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await loadTeachingBrief(testDb(), NOW);

    expect(result.brief).toMatchObject({ brief_id: 'p_sound_after_bad', state: 'finding' });
    expect(warn).toHaveBeenCalledWith(
      '[teaching-brief] skipped candidate',
      expect.objectContaining({
        stage: 'finding',
        candidate_id: 'p_malformed_newer',
        reason: 'proposal_payload_invalid',
      }),
    );
    warn.mockRestore();
  });

  it('uses half-open finding TTL eligibility at the exact millisecond boundary', async () => {
    await seedProposal({
      id: 'p_exactly_expired',
      createdAt: new Date(NOW.getTime() - TEACHING_BRIEF_FINDING_TTL_MS),
    });
    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toEqual({ brief: null });

    await seedProposal({
      id: 'p_one_ms_left',
      createdAt: new Date(NOW.getTime() - TEACHING_BRIEF_FINDING_TTL_MS + 1),
    });
    const result = await loadTeachingBrief(testDb(), NOW);
    expect(result.brief).toMatchObject({ brief_id: 'p_one_ms_left', state: 'finding' });
  });

  it('breaks equal-time outcome and probe ties by id DESC', async () => {
    const resultAt = new Date(NOW.getTime() - 30 * 60 * 1000);
    const outcomeA = await seedOutcome({
      proposalId: 'p_tie_outcome_a',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      resultAt,
    });
    const outcomeB = await seedOutcome({
      proposalId: 'p_tie_outcome_b',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt: new Date(NOW.getTime() - 90 * 60 * 1000),
      resultAt,
    });
    const expectedOutcome = [outcomeA, outcomeB].sort((a, b) =>
      a.resultId < b.resultId ? 1 : -1,
    )[0];
    const outcomeBrief = await loadTeachingBrief(testDb(), NOW);
    expect(outcomeBrief.brief?.current_outcome).toMatchObject({
      probe_result_event_id: expectedOutcome.resultId,
    });

    await resetDb();
    const probeAt = new Date(NOW.getTime() - 30 * 60 * 1000);
    const probeA = await seedAcceptedProbe({
      proposalId: 'p_tie_probe_a',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt,
    });
    const probeB = await seedAcceptedProbe({
      proposalId: 'p_tie_probe_b',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt,
    });
    const expectedProbe = [probeA, probeB].sort().reverse()[0];
    const probeBrief = await loadTeachingBrief(testDb(), NOW);
    expect(probeBrief.brief).toMatchObject({ state: 'probe_ready' });
    expect(probeBrief.brief?.prepared_action).toMatchObject({
      probe_question_id: expectedProbe,
    });
  });

  it('skips a newer probe whose KC drifted from its proposal and keeps the next sound probe', async () => {
    const validProbe = await seedAcceptedProbe({
      proposalId: 'p_valid_probe',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    });
    const corruptProbe = await seedAcceptedProbe({
      proposalId: 'p_corrupt_probe',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    await testDb()
      .update(question)
      .set({ knowledge_ids: ['kn_drifted'] })
      .where(eq(question.id, corruptProbe));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await loadTeachingBrief(testDb(), NOW);

    expect(result.brief).toMatchObject({ brief_id: 'p_valid_probe', state: 'probe_ready' });
    expect(result.brief?.prepared_action).toMatchObject({ probe_question_id: validProbe });
    expect(warn).toHaveBeenCalledWith(
      '[teaching-brief] skipped candidate',
      expect.objectContaining({
        stage: 'probe',
        candidate_id: corruptProbe,
        reason: 'probe_knowledge_mismatch',
      }),
    );
    warn.mockRestore();
  });

  it('logs accepted-without-probe and does not invent a fifth state', async () => {
    await seedProposal({ id: 'p_without_probe', createdAt: new Date(NOW.getTime() - DAY_MS) });
    await acceptProposal('p_without_probe', new Date(NOW.getTime() - 60 * 60 * 1000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await loadTeachingBrief(testDb(), NOW);

    expect(result).toEqual({ brief: null });
    expect(warn).toHaveBeenCalledWith(
      '[teaching-brief] skipped candidate',
      expect.objectContaining({
        stage: 'probe',
        candidate_id: 'p_without_probe',
        reason: 'accepted_without_probe',
      }),
    );
    warn.mockRestore();
  });

  it('ranks pending findings by salience before the bounded window truncates', async () => {
    const newestWindow = Array.from({ length: TEACHING_BRIEF_CANDIDATE_WINDOW }, (_, index) =>
      rawProposalRow({
        id: `p_window_${String(index).padStart(2, '0')}`,
        createdAt: new Date(NOW.getTime() - (TEACHING_BRIEF_CANDIDATE_WINDOW - index) * 60_000),
      }),
    );
    const olderHighSalience = rawProposalRow({
      id: 'p_older_high_salience',
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      confidence: 1,
      recurrenceCount: 100,
    });
    await testDb()
      .insert(event)
      .values([olderHighSalience, ...newestWindow]);

    const result = await loadTeachingBrief(testDb(), NOW);

    // Contract §5: highest-salience fresh finding wins across ALL eligible
    // candidates — recency only breaks ties, and the window cannot evict it.
    expect(result.brief).toMatchObject({ brief_id: 'p_older_high_salience', state: 'finding' });
  });

  it('does not let a burst of decided conjectures evict an older pending finding', async () => {
    const decidedNewer = Array.from({ length: TEACHING_BRIEF_CANDIDATE_WINDOW }, (_, index) =>
      rawProposalRow({
        id: `p_decided_${String(index).padStart(2, '0')}`,
        createdAt: new Date(NOW.getTime() - (TEACHING_BRIEF_CANDIDATE_WINDOW - index) * 60_000),
      }),
    );
    const dismissRates = decidedNewer.map((proposal, index) =>
      rawDismissRateRow(
        proposal.id,
        new Date(NOW.getTime() - (TEACHING_BRIEF_CANDIDATE_WINDOW - index) * 60_000 + 1_000),
      ),
    );
    const olderPending = rawProposalRow({
      id: 'p_pending_behind_decided_burst',
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    });
    await testDb()
      .insert(event)
      .values([olderPending, ...decidedNewer, ...dismissRates]);

    const result = await loadTeachingBrief(testDb(), NOW);

    expect(result.brief).toMatchObject({
      brief_id: 'p_pending_behind_decided_burst',
      state: 'finding',
    });
  });

  it('does not let a burst of corrected conjectures evict an older pending finding', async () => {
    const correctedNewer = Array.from({ length: TEACHING_BRIEF_CANDIDATE_WINDOW }, (_, index) =>
      rawProposalRow({
        id: `p_corrected_${String(index).padStart(2, '0')}`,
        createdAt: new Date(NOW.getTime() - (TEACHING_BRIEF_CANDIDATE_WINDOW - index) * 60_000),
      }),
    );
    const corrections = correctedNewer.map((proposal, index): typeof event.$inferInsert => ({
      id: `correct_${proposal.id}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: proposal.id,
      outcome: 'success',
      payload: { correction_kind: 'retract', reason_md: 'retracted in test' },
      created_at: new Date(
        NOW.getTime() - (TEACHING_BRIEF_CANDIDATE_WINDOW - index) * 60_000 + 1_000,
      ),
    }));
    const olderPending = rawProposalRow({
      id: 'p_pending_behind_corrected_burst',
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    });
    await testDb()
      .insert(event)
      .values([olderPending, ...correctedNewer, ...corrections]);

    const result = await loadTeachingBrief(testDb(), NOW);

    expect(result.brief).toMatchObject({
      brief_id: 'p_pending_behind_corrected_burst',
      state: 'finding',
    });
  });

  it('logs a NULL-draft_status probe as non-canonical (NULL≡active leaves the pool shape)', async () => {
    await testDb()
      .insert(question)
      .values({
        id: 'q_null_status_probe',
        kind: 'short_answer',
        prompt_md: 'probe for p_null',
        source: 'mind_probe',
        source_ref: 'p_null',
        draft_status: null,
        metadata: { conjecture_proposal_id: 'p_null' },
        knowledge_ids: ['kn_p_null'],
        created_at: new Date(NOW.getTime() - 60 * 60 * 1000),
        updated_at: new Date(NOW.getTime() - 60 * 60 * 1000),
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await loadTeachingBrief(testDb(), NOW);

    expect(warn).toHaveBeenCalledWith(
      '[teaching-brief] skipped candidate',
      expect.objectContaining({
        stage: 'probe',
        candidate_id: 'q_null_status_probe',
        reason: 'probe_shape_non_canonical',
      }),
    );
    warn.mockRestore();
  });

  it('does not let a flood of corrupt results evict an older valid outcome', async () => {
    await seedOutcome({
      proposalId: 'p_valid_outcome',
      proposalAt: new Date(NOW.getTime() - 3 * DAY_MS),
      probeAt: new Date(NOW.getTime() - 2 * DAY_MS),
      resultAt: new Date(NOW.getTime() - DAY_MS),
    });
    // Newer results with non-canonical resolution/outcome pairs — these must be
    // filtered before the bounded window, not occupy it.
    const corrupt = Array.from(
      { length: TEACHING_BRIEF_CANDIDATE_WINDOW },
      (_, index): typeof event.$inferInsert => ({
        id: `res_corrupt_${String(index).padStart(2, '0')}`,
        actor_kind: 'system',
        actor_ref: 'judge',
        action: 'experimental:probe_result',
        subject_kind: 'question',
        subject_id: `q_missing_${index}`,
        outcome: 'success',
        payload: { resolution: 'confirmed', outcome: 1, conjecture_event_id: 'evt_nowhere' },
        created_at: new Date(NOW.getTime() - (TEACHING_BRIEF_CANDIDATE_WINDOW - index) * 60_000),
      }),
    );
    await testDb().insert(event).values(corrupt);

    const result = await loadTeachingBrief(testDb(), NOW);

    expect(result.brief).toMatchObject({ brief_id: 'p_valid_outcome', state: 'outcome_confirmed' });
  });

  it('keeps a corrected-then-restored finding eligible (latest correction wins)', async () => {
    const proposal = rawProposalRow({
      id: 'p_restored',
      createdAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
    });
    const retractAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const restoreAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    const corrections: Array<typeof event.$inferInsert> = [
      {
        id: 'correct_p_restored_retract',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: proposal.id,
        outcome: 'success',
        payload: { correction_kind: 'retract', reason_md: 'retracted in test' },
        created_at: retractAt,
      },
      {
        id: 'correct_p_restored_restore',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: proposal.id,
        outcome: 'success',
        payload: { correction_kind: 'restore', reason_md: 'restored in test' },
        created_at: restoreAt,
      },
    ];
    await testDb()
      .insert(event)
      .values([proposal, ...corrections]);

    const result = await loadTeachingBrief(testDb(), NOW);

    expect(result.brief).toMatchObject({ brief_id: 'p_restored', state: 'finding' });
  });

  it('keeps a large accepted-without-probe quiet state bounded to constant SELECT round-trips', async () => {
    const proposalRows = Array.from({ length: TEACHING_BRIEF_CANDIDATE_WINDOW + 30 }, (_, index) =>
      rawProposalRow({
        id: `p_perf_${String(index).padStart(3, '0')}`,
        createdAt: new Date(NOW.getTime() - (index + 2) * 60_000),
      }),
    );
    const rateRows = proposalRows.map((proposal, index) =>
      rawAcceptRateRow(proposal.id, new Date(NOW.getTime() - (index + 1) * 60_000)),
    );
    await testDb()
      .insert(event)
      .values([...proposalRows, ...rateRows]);
    const counted = selectCountingDb(testDb());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await loadTeachingBrief(counted.db, NOW);

    expect(result).toEqual({ brief: null });
    expect(counted.selectCount()).toBeLessThanOrEqual(7);
    expect(
      warn.mock.calls.filter(([, detail]) =>
        String((detail as { reason?: unknown }).reason).includes('accepted_without_probe'),
      ),
    ).toHaveLength(TEACHING_BRIEF_CANDIDATE_WINDOW);
    warn.mockRestore();
  });

  it('propagates query failures instead of presenting them as calm null', async () => {
    const queryError = new Error('query unavailable');
    const failingDb = {
      select() {
        throw queryError;
      },
    } as unknown as Db;

    await expect(loadTeachingBrief(failingDb, NOW)).rejects.toBe(queryError);
  });

  it('never leaks calibration fields or values and performs zero writes', async () => {
    await seedProposal({
      id: 'p_antiguilt',
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      confidence: 0.731942,
      predictedP: 0.217483,
      baselineP: 0.839651,
    });
    const before = await tableCounts();

    const response = await loadTeachingBrief(testDb(), NOW);

    expect(await tableCounts()).toEqual(before);
    const json = JSON.stringify(response);
    for (const forbidden of [
      'confidence',
      'predicted_p',
      'baseline_p_at_induction',
      'retrievability_at_judge',
      '0.731942',
      '0.217483',
      '0.839651',
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('returns calm null on an empty database and registers the route', async () => {
    await expect(loadTeachingBrief(testDb(), NOW)).resolves.toEqual({ brief: null });
    const routes = shellCapability.api?.routes.map((r) => `${r.method} ${r.path}`) ?? [];
    expect(routes).toContain('GET /api/prep-desk/brief');
  });

  it('a malformed result excludes its probe from active and is never re-presented for answering', async () => {
    const probeId = await seedAcceptedProbe({
      proposalId: 'p_corrupt_result',
      proposalAt: new Date(NOW.getTime() - DAY_MS),
      probeAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    await writeEvent(testDb(), {
      id: 'r_bad_pair',
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: 'experimental:probe_result',
      subject_kind: 'question',
      subject_id: probeId,
      payload: {
        conjecture_event_id: 'p_corrupt_result',
        outcome: 1,
        resolution: 'confirmed',
      },
      caused_by_event_id: 'p_corrupt_result',
      created_at: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await loadTeachingBrief(testDb(), NOW);

    expect(result).toEqual({ brief: null });
    expect(warn).toHaveBeenCalledWith(
      '[teaching-brief] skipped candidate',
      expect.objectContaining({ reason: 'outcome_resolution_mismatch' }),
    );
    warn.mockRestore();
  });
});

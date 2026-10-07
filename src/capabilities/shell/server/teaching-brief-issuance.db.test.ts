import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeAnswerResponseSchema } from '@/capabilities/agency/api/contracts';
import { POST } from '@/capabilities/agency/api/probe-answer';
import { answerProbe, serveProbeOnce, servePublishedProbe } from '@/capabilities/agency/public';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import {
  assessment_issuance,
  event,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { computeTeachingBriefReport } from '../../../../scripts/lib/teaching-brief-report';
import { loadTeachingBriefReportInput } from '../../../../scripts/report-teaching-brief';
import { publishPaperModelFixture } from '../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as ACK } from '../api/teaching-brief-ack';
import {
  TEACHING_BRIEF_CANDIDATE_WINDOW,
  TEACHING_BRIEF_OUTCOME_TTL_MS,
  loadTeachingBrief,
  validateAckableOutcome,
} from './teaching-brief';

const NOW = new Date('2026-10-07T12:00:00Z');
const PROMPT =
  '说明复合函数 sin(x²) 的导数。\n\n请区分外层与内层导数，写出推导过程，并解释为什么两者相乘而不是相加。';

async function seedProbe(id: string, minutesAgo: number, issued = true) {
  const db = testDb();
  const createdAt = new Date(NOW.getTime() - minutesAgo * 60_000);
  await writeAiProposal(db, {
    id,
    actor_ref: 'research_meeting',
    created_at: createdAt,
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: 'kn_chain_rule' },
      reason_md:
        '两次复合函数求导记录都缺少内层导数；另一次独立练习正确，需要探针区分偶发遗漏与稳定错误。',
      evidence_refs: [
        { kind: 'event', id: 'evt_nested_work' },
        { kind: 'question', id: 'q_independent_transfer' },
      ],
      cooldown_key: `conjecture:${id}`,
      proposed_change: {
        claim_md: '复合函数求导时可能把内层与外层导数相加。',
        knowledge_id: 'kn_chain_rule',
        cause_category: 'concept_misunderstanding',
        confidence: 0.7,
        recurrence_count: 2,
        probe_md: PROMPT,
        probe_reference_md:
          '2x cos(x²)。外层导数 cos(x²) 乘以内层导数 2x；x=0 的相同结果不能证明一般规则。',
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
  await writeEvent(db, {
    id: `rate_${id}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: id,
    outcome: 'success',
    payload: { rating: 'accept', conjecture_id: id, calibration_anchor: 'accept' },
    caused_by_event_id: id,
    created_at: createdAt,
  });
  const served = await serveProbeOnce({
    db,
    conjectureProposalId: id,
    knowledgeId: 'kn_chain_rule',
    probeMd: PROMPT,
    referenceMd: '2x cos(x²)。外层导数 cos(x²) 乘以内层导数 2x；x=0 的相同结果不能证明一般规则。',
    now: createdAt,
  });
  if (served.status !== 'served') throw new Error(`fixture serve failed: ${served.status}`);
  if (issued) {
    await publishPaperModelFixture(db, served.probe_question_id);
    await servePublishedProbe(db, served.probe_question_id);
  }
  return served.probe_question_id;
}

async function expectProbe(probeId: string) {
  const response = await loadTeachingBrief(testDb(), NOW);
  expect(response.brief).toMatchObject({
    state: 'probe_ready',
    prepared_action: { kind: 'answer_probe', probe_question_id: probeId, prompt_md: PROMPT },
  });
  return response;
}

describe('YUK-1364 TeachingBrief frozen issuance eligibility', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not advertise a legacy probe rejected by submit as probe_not_issued', async () => {
    const probeId = await seedProbe('legacy_unissued', 10, false);
    const response = await POST(
      new Request('http://test.invalid/probe/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer_md: '2x cos(x²), because the two derivatives multiply.' }),
      }),
      { id: probeId },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'probe_not_issued' });
    expect(await loadTeachingBrief(testDb(), NOW)).toEqual({ brief: null });
    expect(await testDb().select().from(assessment_issuance)).toHaveLength(0);
    // Admission alone is still not a serve record; the GET must not mint one.
    await publishPaperModelFixture(testDb(), probeId);
    expect(await loadTeachingBrief(testDb(), NOW)).toEqual({ brief: null });
    expect(await testDb().select().from(assessment_issuance)).toHaveLength(0);
  });

  it('filters more than a candidate window of newer unissued rows before choosing an eligible fallback', async () => {
    const eligible = await seedProbe('older_eligible', 120);
    const legacy = await seedProbe('newer_legacy', 10, false);
    const [row] = await testDb().select().from(question).where(eq(question.id, legacy));
    await testDb()
      .insert(question)
      .values(
        Array.from({ length: TEACHING_BRIEF_CANDIDATE_WINDOW }, (_, i) => ({
          ...row,
          id: `legacy_window_${i}`,
        })),
      );
    await expectProbe(eligible);
  });

  it.each(['withheld', 'suspended', 'withdrawn'] as const)(
    'skips a newer %s issuance and selects the eligible fallback',
    async (state) => {
      const eligible = await seedProbe('older_eligible', 120);
      const invalid = await seedProbe('newer_unavailable', 10);
      await testDb()
        .update(question_group_lifecycle)
        .set(
          state === 'withheld'
            ? {
                scoring_admission_state: 'withheld',
                scoring_admission_withheld_reason: 'owner_hold',
              }
            : { [state]: true },
        )
        .where(eq(question_group_lifecycle.group_id, invalid));
      await expectProbe(eligible);
    },
  );

  it('excludes an issued probe with no lifecycle record without recreating it', async () => {
    const eligible = await seedProbe('older_eligible', 120);
    const invalid = await seedProbe('newer_missing_lifecycle', 10);
    await testDb()
      .delete(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, invalid));
    await expectProbe(eligible);
    expect(
      await testDb()
        .select()
        .from(question_group_lifecycle)
        .where(eq(question_group_lifecycle.group_id, invalid)),
    ).toHaveLength(0);
  });

  it.each(['invalid', 'prompt', 'reference', 'version'] as const)(
    'keeps the submit authored-snapshot guard when its %s field drifts',
    async (drift) => {
      const eligible = await seedProbe('older_eligible', 120);
      const invalid = await seedProbe('newer_snapshot_drift', 10);
      const [row] = await testDb().select().from(question).where(eq(question.id, invalid));
      await testDb()
        .update(question)
        .set({
          metadata: {
            ...row.metadata,
            probe_spec:
              drift === 'invalid'
                ? { prompt_md: PROMPT }
                : {
                    prompt_md: PROMPT,
                    reference_md: row.reference_md,
                    expected_target_error_answer_md: 'cos(x²) + 2x',
                    elicits_target_error_reason_md: '区分链式法则的乘法与加法。',
                    context_kind: 'abstract',
                    representation_kind: 'symbolic',
                  },
          },
          ...(drift === 'prompt' ? { prompt_md: '已经改变的题干' } : {}),
          ...(drift === 'reference' ? { reference_md: '已经改变的参考' } : {}),
          ...(drift === 'version' ? { version: row.version + 1 } : {}),
        })
        .where(eq(question.id, invalid));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const response = await POST(
        new Request('http://test.invalid/probe/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer_md: '2x cos(x²)' }),
        }),
        { id: invalid },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: drift === 'invalid' ? 'probe_snapshot_invalid' : 'probe_snapshot_changed',
      });
      await expectProbe(eligible);
    },
  );

  it.each(['wrong_group', 'unknown_part', 'unsupported_response', 'malformed_response'] as const)(
    'skips a newer %s frozen record without failing the whole read',
    async (invalidKind) => {
      const eligible = await seedProbe('older_eligible', 120);
      const invalid = await seedProbe('newer_invalid_binding', 10, false);
      await publishPaperModelFixture(testDb(), invalid);
      const [revision] = await testDb()
        .select()
        .from(question_revision)
        .where(eq(question_revision.group_id, invalid));
      const [template] = await testDb()
        .select()
        .from(assessment_issuance)
        .where(eq(assessment_issuance.issuance_id, `iss_probe_${eligible}`));
      let revisionId = revision.revision_id;
      if (invalidKind === 'unsupported_response' || invalidKind === 'malformed_response') {
        revisionId = `${revision.revision_id}_unsupported`;
        await testDb()
          .insert(question_revision)
          .values({
            ...revision,
            revision_id: revisionId,
            revision_ordinal: revision.revision_ordinal + 10,
            response_spec:
              invalidKind === 'malformed_response'
                ? sql`'{"slots":{"kind":"open_response"}}'::jsonb`
                : { slots: [] },
          });
      }
      await testDb()
        .insert(assessment_issuance)
        .values({
          ...template,
          issuance_id: `iss_probe_${invalid}`,
          revision_id: invalidKind === 'wrong_group' ? template.revision_id : revisionId,
          part_ids:
            invalidKind === 'unknown_part'
              ? ['missing_part']
              : revision.structure.parts.map((part) => part.part_id),
          container_occurrence_ref: `probe:${invalid}`,
        });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expectProbe(eligible);
    },
  );

  it('keeps the issued prompt after mutable prompt/reference edits and a later admitted publication, with zero read writes', async () => {
    const probeId = await seedProbe('frozen_truth', 10);
    const served = await expectProbe(probeId);
    await testDb()
      .update(question)
      .set({
        prompt_md: '新题干不能替代已经发出的原题。',
        reference_md: '新的评分参考也不能影响原发题。',
        version: 2,
      })
      .where(eq(question.id, probeId));
    const [lifecycle] = await testDb()
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, probeId));
    const contract = await publishPaperModelFixture(testDb(), probeId);
    const [current] = await testDb()
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, probeId));
    contract.structure.parts[0].prompt_md = '另一份已经准入的修订题干，也不能覆盖原发题。';
    contract.integrity_digest = contractIntegrityDigest(contract);
    expect(
      await publishQuestionGroup(testDb(), {
        group_id: probeId,
        contract,
        expectedCurrentRevision: current.current_revision_id,
        expectedAdmissionGeneration: current.scoring_admission_generation,
        availability: lifecycle.availability,
        actorRef: 'test:later-probe-revision',
        now: NOW,
        admission: { state: 'admitted', evidence: current.scoring_admission_evidence },
      }),
    ).toMatchObject({ status: 'published' });
    const snapshot = () =>
      Promise.all([
        testDb().select().from(assessment_issuance),
        testDb().select().from(question_revision),
        testDb().select().from(question_group_lifecycle),
        testDb().select().from(event),
        testDb().select().from(question),
      ]);
    const before = await snapshot();
    expect(await loadTeachingBrief(testDb(), NOW)).toEqual(served);
    expect(await loadTeachingBrief(testDb(), NOW)).toEqual(served);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['correct', 'incorrect'] as const)(
    'delivers and acknowledges the %s frozen answer after legacy prompt/reference edits, and counts it in the report',
    async (answerResult) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      __resetRateLimitForTests();
      const db = testDb();
      const probeId = await seedProbe('frozen_completed', 10);
      const [original] = await db.select().from(question).where(eq(question.id, probeId));
      expect(original.metadata).not.toHaveProperty('probe_spec');
      await db
        .update(question)
        .set({
          prompt_md: '把原题改为求 sin(x³) 的导数，并比较两种复合函数。',
          reference_md: '3x² cos(x³)。此参考属于新题，不能给原答评分。',
          version: original.version + 1,
        })
        .where(eq(question.id, probeId));
      await expectProbe(probeId);

      const execute = vi.fn<Parameters<typeof createRecordedModelExecutor>[1]>(
        async (input, _signal, runId) => ({
          kind: 'scored',
          points_awarded: answerResult === 'correct' ? (input.unit.points ?? 0) : 0,
          matched: {
            rule_id:
              input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : '',
            option_ids: [],
          },
          confidence: 0.9,
          feedback_md: '离线模型结果；评分对象是冻结的原题与原参考。',
          evidence_citations: input.slot_responses.flatMap((entry) =>
            entry.kind === 'open' && entry.text_md
              ? [{ slot_id: entry.slot_id, quote: entry.text_md }]
              : [],
          ),
          run_refs: [runId],
          cost_usd_micros: 0,
        }),
      );
      vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(() =>
        createRecordedModelExecutor(db, execute),
      );
      const response = await POST(
        new Request('http://test.invalid/probe/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            answer_md:
              answerResult === 'correct'
                ? '外层 cos(x²) 乘以内层 2x，得到 2x cos(x²)；x=0 不是一般规律。'
                : '外层与内层导数相加，得到 cos(x²) + 2x。',
          }),
        }),
        { id: probeId },
      );
      expect(response.status).toBe(200);
      const result = ProbeAnswerResponseSchema.parse(await response.json());
      const resolution = answerResult === 'correct' ? 'retired' : 'confirmed';
      expect(result).toMatchObject({ status: resolution, coarse_outcome: answerResult });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0]).toMatchObject({
        question_parts: [{ prompt_md: PROMPT }],
        unit: { criterion: { statement_md: original.reference_md } },
      });

      const [resultEvent] = await db
        .select()
        .from(event)
        .where(eq(event.id, result.probe_result_event_id));
      // Soft assertions exercise the whole completed chain even when delivery fails.
      expect.soft(await validateAckableOutcome(db, resultEvent, NOW)).not.toHaveProperty('reason');
      expect.soft((await loadTeachingBrief(db, NOW)).brief).toMatchObject({
        state: `outcome_${resolution}`,
        current_outcome: { probe_result_event_id: result.probe_result_event_id },
      });
      const ack = await ACK(
        new Request('http://test.invalid/prep-desk/brief/ack', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ probe_result_event_id: result.probe_result_event_id }),
        }),
      );
      expect.soft(ack.status).toBe(201);
      expect.soft(await ack.json()).toMatchObject({
        probe_result_event_id: result.probe_result_event_id,
        idempotent: false,
      });
      expect.soft(await loadTeachingBrief(db, NOW)).toEqual({ brief: null });
      const report = computeTeachingBriefReport(
        await loadTeachingBriefReportInput(db, '2026-10-07', '2026-10-07'),
      );
      expect.soft(report.outcomes).toEqual({
        evidence_for: 0,
        confirmed: answerResult === 'incorrect' ? 1 : 0,
        retired: answerResult === 'correct' ? 1 : 0,
      });
      expect.soft(report.probe_completion).toEqual({ numerator: 1, denominator: 1, rate: 1 });
      expect.soft(report.skipped_corrupt_outcomes).toBe(0);
    },
  );

  it.each(['withheld', 'suspended', 'withdrawn', 'missing_lifecycle'] as const)(
    'preserves an issued completed outcome after %s and later authored-snapshot edits, including its historical report',
    async (state) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const db = testDb();
      const proposalId = 'completed_lifecycle';
      const probeId = await seedProbe(proposalId, 10);
      const [original] = await db.select().from(question).where(eq(question.id, probeId));
      await db
        .update(question)
        .set({
          metadata: {
            ...original.metadata,
            probe_spec: {
              prompt_md: PROMPT,
              reference_md: original.reference_md,
              expected_target_error_answer_md: 'cos(x²) + 2x',
              elicits_target_error_reason_md: '区分链式法则的乘法与加法。',
              context_kind: 'abstract',
              representation_kind: 'symbolic',
            },
          },
        })
        .where(eq(question.id, probeId));
      const completed = await answerProbe({ db, probeQuestionId: probeId, outcome: 1, now: NOW });
      expect(completed.status).toBe('retired');
      await db
        .update(question)
        .set({ prompt_md: '后续修改的题干', reference_md: '后续修改的参考', version: 2 })
        .where(eq(question.id, probeId));
      if (state === 'missing_lifecycle') {
        await db
          .delete(question_group_lifecycle)
          .where(eq(question_group_lifecycle.group_id, probeId));
      } else {
        await db
          .update(question_group_lifecycle)
          .set(
            state === 'withheld'
              ? {
                  scoring_admission_state: 'withheld',
                  scoring_admission_withheld_reason: 'owner_hold',
                }
              : { [state]: true },
          )
          .where(eq(question_group_lifecycle.group_id, probeId));
      }
      expect((await loadTeachingBrief(db, NOW)).brief).toMatchObject({
        state: 'outcome_retired',
        current_outcome: { probe_result_event_id: completed.probe_result_event_id },
      });
      const [resultEvent] = await db
        .select()
        .from(event)
        .where(eq(event.id, completed.probe_result_event_id));
      const snapshot = () =>
        Promise.all([
          db.select().from(assessment_issuance),
          db.select().from(question_revision),
          db.select().from(question_group_lifecycle),
          db.select().from(event),
          db.select().from(question),
        ]);
      const before = await snapshot();
      await loadTeachingBrief(db, NOW);
      expect(await validateAckableOutcome(db, resultEvent, NOW)).not.toHaveProperty('reason');
      expect(await snapshot()).toEqual(before);

      __resetRateLimitForTests();
      const ack = await ACK(
        new Request('http://test.invalid/prep-desk/brief/ack', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ probe_result_event_id: completed.probe_result_event_id }),
        }),
      );
      expect(ack.status).toBe(201);
      const later = new Date(NOW.getTime() + TEACHING_BRIEF_OUTCOME_TTL_MS + 1);
      vi.setSystemTime(later);
      expect(await validateAckableOutcome(db, resultEvent, later)).toEqual({
        reason: 'result_expired',
      });
      await writeEvent(db, {
        id: 'later_proposal_retract',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: proposalId,
        outcome: 'success',
        payload: {
          correction_kind: 'retract',
          reason_md: '结果送达后撤回原判断。',
          affected_refs: [{ kind: 'question', id: probeId }],
        },
        caused_by_event_id: proposalId,
        created_at: later,
      });
      const report = computeTeachingBriefReport(
        await loadTeachingBriefReportInput(db, '2026-10-07', '2026-10-07'),
      );
      expect(report.outcomes).toEqual({ evidence_for: 0, confirmed: 0, retired: 1 });
      expect(report.skipped_corrupt_outcomes).toBe(0);
    },
  );

  it('keeps legitimate pre-issuance completed outcomes eligible without creating frozen records', async () => {
    const db = testDb();
    const probeId = await seedProbe('historical_pre_issuance', 10, false);
    const completed = await answerProbe({ db, probeQuestionId: probeId, outcome: 1, now: NOW });
    const revisions = await db.select().from(question_revision);
    const lifecycle = await db.select().from(question_group_lifecycle);
    expect((await loadTeachingBrief(db, NOW)).brief).toMatchObject({
      state: 'outcome_retired',
      current_outcome: { probe_result_event_id: completed.probe_result_event_id },
    });
    expect(await db.select().from(assessment_issuance)).toHaveLength(0);
    expect(await db.select().from(question_revision)).toEqual(revisions);
    expect(await db.select().from(question_group_lifecycle)).toEqual(lifecycle);
  });

  it('still excludes an issued probe after a terminal result', async () => {
    const probeId = await seedProbe('answered_probe', 10);
    await answerProbe({ db: testDb(), probeQuestionId: probeId, outcome: 1, now: NOW });
    expect((await loadTeachingBrief(testDb(), NOW)).brief?.prepared_action.kind).not.toBe(
      'answer_probe',
    );
  });
});

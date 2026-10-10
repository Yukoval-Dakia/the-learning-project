import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeAnswerResponseSchema } from '@/capabilities/agency/api/contracts';
import { POST } from '@/capabilities/agency/api/probe-answer';
import {
  getEffectiveProbeResultStatuses,
  serveProbeOnce,
  servePublishedProbe,
} from '@/capabilities/agency/public';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import {
  assessment_issuance,
  event,
  knowledge,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { editQuestion } from '@/server/questions/write';
import { computeTeachingBriefReport } from '../../../../scripts/lib/teaching-brief-report';
import { loadTeachingBriefReportInput } from '../../../../scripts/report-teaching-brief';
import { publishPaperModelFixture } from '../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as ACK } from '../api/teaching-brief-ack';
import { loadTeachingBrief, validateAckableOutcome } from './teaching-brief';

const NOW = new Date('2026-10-07T12:00:00Z');
const PROMPT =
  '说明复合函数 sin(x²) 的导数。\n\n请区分外层与内层导数，写出推导过程，并解释为什么两者相乘而不是相加。';
const FOLLOWUP_PROMPT =
  '独立复验：求 cos(x³) 的导数。\n\n写出外层负号和内层导数，比较 x=0 与 x=1，并解释为什么不能用特殊点验证一般规则。';
const FOLLOWUP_REFERENCE =
  '-3x² sin(x³)。外层导数 -sin(x³) 乘以内层导数 3x²；特殊点的相同结果不足以验证链式法则。';

async function seedProbe(id: string, minutesAgo: number, issued = true, includeFollowup = false) {
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
        ...(includeFollowup
          ? {
              followup_probe_md: FOLLOWUP_PROMPT,
              followup_probe_reference_md: FOLLOWUP_REFERENCE,
            }
          : {}),
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

async function editCompletedProbe(probeId: string) {
  const db = testDb();
  const [row] = await db.select().from(question).where(eq(question.id, probeId));
  expect(
    await editQuestion(
      db,
      probeId,
      row.version,
      { knowledge_ids: [], draft_status: 'active' },
      'self',
    ),
  ).toMatchObject({ status: 'updated', version: row.version + 1 });
  await db.insert(knowledge).values({
    id: `relabeled_${probeId}`,
    name: '后续编目知识点',
    created_at: NOW,
    updated_at: NOW,
  });
  expect(
    await editQuestion(
      db,
      probeId,
      row.version + 1,
      {
        knowledge_ids: [`relabeled_${probeId}`],
        kind: 'choice',
        choices_md: ['A: 内外层相加', 'B: 内外层相乘'],
        prompt_md: '后续编目题面，不能重写已经完成的原题。',
        reference_md: '后续题目参考，不能重写原结果。',
      },
      'self',
    ),
  ).toMatchObject({ status: 'updated', version: row.version + 2 });
}

describe('YUK-1364 TeachingBrief frozen issuance eligibility', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['correct', 'incorrect'] as const)(
    'delivers and acknowledges the %s frozen answer after normal KC/draft edits, and counts it in the report',
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
      await editCompletedProbe(probeId);
      const snapshot = () =>
        Promise.all([
          db.select().from(question),
          db.select().from(event),
          db.select().from(assessment_issuance),
          db.select().from(question_revision),
          db.select().from(question_group_lifecycle),
        ]);
      const before = await snapshot();
      expect(
        (
          await getEffectiveProbeResultStatuses(db, [resultEvent.id], { validateDirectChain: true })
        ).get(resultEvent.id),
      ).toBe('active');
      // Soft assertions exercise the whole completed chain even when delivery fails.
      expect.soft(await validateAckableOutcome(db, resultEvent, NOW)).not.toHaveProperty('reason');
      expect.soft((await loadTeachingBrief(db, NOW)).brief).toMatchObject({
        state: `outcome_${resolution}`,
        current_outcome: { probe_result_event_id: result.probe_result_event_id },
      });
      expect(await snapshot()).toEqual(before);
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
});

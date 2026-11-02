import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { issueAssessment } from '@/capabilities/practice/server/assessment/issue';
import { getFrozenPaperDetail } from '@/capabilities/practice/server/assessment/paper-detail';
import { PaperAssessmentBinding } from '@/capabilities/practice/server/assessment/paper-issuance';
import {
  getIssuanceState,
  saveResponseDraft,
  saveSubmission,
} from '@/capabilities/practice/server/assessment/submit';
import {
  type EvaluateSubmissionRequest,
  evaluateSubmission,
} from '@/capabilities/practice/server/judge/evaluate-submission';
import { getStream, streamLocalDate } from '@/capabilities/practice/server/stream-store';
import type { ModelUnitOutcomeT } from '@/core/schema/assessment';
import {
  artifact,
  assessment_issuance,
  assessment_response_draft,
  assessment_submission,
  evaluation_effective_head,
  event,
  mastery_state,
  material_fsrs_state,
  practice_stream_item,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { readAutomaticIssuanceServingDecisions } from '@/kernel/records/assessment-issuance';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import {
  type NormalizableQuestionRow,
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { seedHistoricalAssessmentIssuance } from '../../../tests/fixtures/historical-assessment-issuance';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { activateEvaluation } from './activate';
import { learningSettlement } from './settle';

const NOW = new Date('2026-10-04T00:00:00.000Z');
const EVIDENCE = {
  marking_provenance: 'official' as const,
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

async function seed(
  opts: { withheld?: boolean; model?: boolean; id?: string; evaluationGroupId?: string } = {},
) {
  const db = testDb();
  await db.insert(question).values({
    id: opts.id ?? 'admission-q',
    kind: 'choice',
    prompt_md:
      '雨水沿坡面流动。保持水量与表面材质，改变坡度。\n|坡度|流速|\n|5°|0.4 m/s|\n|10°|0.8 m/s|\n哪项是受控变量？',
    reference_md: 'B',
    choices_md: ['坡度', '水量与材质', '测得的流速'],
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    variant_depth: 0,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
  const [row] = await db
    .select()
    .from(question)
    .where(eq(question.id, opts.id ?? 'admission-q'));
  const contract = normalizeQuestionRowToContract(row as NormalizableQuestionRow);
  if (opts.model)
    contract.execution_plan.assignments[0].executor = {
      kind: 'model_executor',
      task_kind: 'JevScoringDecisionTask',
      admitted_slice_id: 'test:admitted-slice',
    };
  contract.integrity_digest = contractIntegrityDigest(contract);
  const published = await publishQuestionGroup(db, {
    group_id: row.id,
    contract,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: opts.withheld
      ? { state: 'withheld', reason: 'owner_hold' }
      : { state: 'admitted', evidence: EVIDENCE },
    actorRef: 'test:admission',
    now: NOW,
  });
  if (published.status !== 'published') throw new Error(published.status);
  const issue = opts.withheld || opts.model ? seedHistoricalAssessmentIssuance : issueAssessment;
  const issued = await issue(db, {
    group_id: row.id,
    mode: 'auto_score',
    now: NOW,
  });
  if (issued.status !== 'issued') throw new Error(issued.status);
  const slot = contract.response_spec.slots[0];
  if (slot.kind !== 'single_choice') throw new Error('expected choice');
  const saved = await saveSubmission(db, {
    issuance_id: issued.issuance.issuance_id,
    evaluation_group_id: opts.evaluationGroupId ?? 'admission-group',
    idempotency_key: 'confirmed-answer',
    response_set: {
      entries: [{ slot_id: slot.slot_id, kind: 'choice', option_ids: [slot.options[1].option_id] }],
    },
    now: NOW,
  });
  if (saved.status !== 'saved') throw new Error(saved.status);
  return { row, contract, published, issued, saved };
}
type Seed = Awaited<ReturnType<typeof seed>>;

function evaluate(s: Seed, extra: Partial<EvaluateSubmissionRequest> = {}) {
  return evaluateSubmission(testDb(), {
    submission_id: s.saved.submission.submission_id,
    evaluation_group_id: 'admission-group',
    ...extra,
  });
}
function activate(id: string, observed?: number) {
  return testDb().transaction((tx) =>
    activateEvaluation(
      tx,
      {
        evaluation_id: id,
        expected_effective_id: null,
        expected_generation: 0,
        ...(observed === undefined ? {} : { admission_generation_observed: observed }),
      },
      { settle: learningSettlement, now: NOW },
    ),
  );
}
async function changeAdmission(s: Seed, state: 'admitted' | 'withheld') {
  const [current] = await testDb()
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, s.row.id));
  return publishQuestionGroup(testDb(), {
    group_id: s.row.id,
    contract: s.contract,
    expectedCurrentRevision: current.current_revision_id,
    expectedAdmissionGeneration: current.scoring_admission_generation,
    availability: 'general_pool',
    admission:
      state === 'admitted' ? { state, evidence: EVIDENCE } : { state, reason: 'owner_hold' },
    actorRef: 'test:verify',
    now: NOW,
  });
}
async function expectNoActivation() {
  const [head] = await testDb()
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, 'admission-group'));
  expect(head).toMatchObject({ effective_evaluation_id: null, generation: 0 });
  expect(
    await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_activation')),
  ).toEqual([]);
  expect(await testDb().select().from(material_fsrs_state)).toEqual([]);
  expect(await testDb().select().from(mastery_state)).toEqual([]);
}

describe('YUK-1045 authoritative candidate admission snapshot', () => {
  beforeEach(resetDb);

  // @invariant grading: neither auto, manual, nor replay issuance can serve a withdrawn-admission group, and every rejected attempt leaves historical rows, events, and accepted work byte-identical
  // @fails-if let issueAssessment admit on mode 'manual' or when reusing an issuance_id (replay); a not_admitted status or the before/after equality assertions fail
  it('rejects manual and replay serving without changing historical issuance or accepted work', async () => {
    const s = await seed({ model: true });
    const unanswered = await seedHistoricalAssessmentIssuance(testDb(), {
      group_id: s.row.id,
      now: NOW,
    });
    const beforeRows = await testDb().select().from(assessment_issuance);
    const beforeEvents = await testDb().select().from(event);
    const acceptedBefore = await getIssuanceState(testDb(), s.issued.issuance.issuance_id);
    expect(acceptedBefore.practice_dto).not.toBeNull();
    expect(acceptedBefore.submissions).toHaveLength(1);
    expect(
      (await getIssuanceState(testDb(), unanswered.issuance.issuance_id)).practice_dto,
    ).toBeNull();
    const decisions = await readAutomaticIssuanceServingDecisions(testDb(), [
      unanswered.issuance.issuance_id,
    ]);
    expect(decisions.get(unanswered.issuance.issuance_id)).toMatchObject({
      kind: 'unavailable',
      reason: 'model_admission_unavailable',
    });
    for (const mode of ['auto_score', 'manual'] as const) {
      for (const issuance_id of [undefined, unanswered.issuance.issuance_id]) {
        expect(
          await issueAssessment(testDb(), { group_id: s.row.id, mode, issuance_id }),
        ).toMatchObject({
          status: 'not_admitted',
        });
      }
    }
    expect(await testDb().select().from(assessment_issuance)).toEqual(beforeRows);
    expect(await testDb().select().from(event)).toEqual(beforeEvents);
    expect(await getIssuanceState(testDb(), s.issued.issuance.issuance_id)).toEqual(acceptedBefore);
  });

  it('keeps already-effective replay idempotent after admission is withdrawn', async () => {
    const s = await seed();
    const candidate = await evaluate(s);
    expect((await activate(candidate.record.evaluation_id)).status).toBe('activated');
    const before = await testDb().select().from(material_fsrs_state);
    await changeAdmission(s, 'withheld');
    expect(await activate(candidate.record.evaluation_id)).toMatchObject({
      status: 'already_effective',
      effect: 'idempotent_replay',
    });
    expect(await testDb().select().from(material_fsrs_state)).toEqual(before);
  });

  it('captures admission before the executor runs, so a concurrent verification cannot refresh it', async () => {
    const s = await seed({ model: true });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const pending = evaluate(s, {
      model_executor: async () => {
        entered.resolve();
        await finish.promise;
        return {
          kind: 'scored',
          points_awarded: 1,
          matched: { option_ids: [] },
          evidence_citations: [],
          run_refs: [],
        } satisfies ModelUnitOutcomeT;
      },
    });
    try {
      await entered.promise;
      await changeAdmission(s, 'withheld');
    } finally {
      finish.resolve();
    }
    const candidate = await pending;
    expect(candidate.record.provenance).toMatchObject({
      admission_snapshot: { generation: s.published.admission_generation, state: 'admitted' },
    });
    expect((await activate(candidate.record.evaluation_id)).status).toBe('stale_admission');
    await expectNoActivation();
  });

  // @invariant data: budget trimming deletes only eligible tail items — the accepted recovery entry point and stored unsupported rows survive, and serving reads never mutate issuance or submission history
  // @fails-if make the trim treat the recovery/withheld rows as eligible or let the stream read mutate issuance/submissions; the storedIds or before/after equality assertions fail
  it('keeps the accepted recovery row reachable and untouchable while the budget trims eligible tails', async () => {
    const db = testDb();
    const admitted = await seed();
    const model = await seed({
      model: true,
      id: 'admission-q-model',
      evaluationGroupId: 'model-group',
    });
    const slot = model.contract.response_spec.slots[0];
    if (slot.kind !== 'single_choice') throw new Error('expected choice');
    // Recovery row: pinned unsupported issuance already holds an accepted submission.
    await seedHistoricalAssessmentIssuance(db, {
      group_id: model.row.id,
      issuance_id: 'iss_stream_recovery',
      now: NOW,
    });
    const recovered = await saveSubmission(db, {
      issuance_id: 'iss_stream_recovery',
      evaluation_group_id: 'stream-recovery-group',
      idempotency_key: 'stream-recovery-answer',
      response_set: {
        entries: [
          { slot_id: slot.slot_id, kind: 'choice', option_ids: [slot.options[1].option_id] },
        ],
      },
      now: NOW,
    });
    if (recovered.status !== 'saved') throw new Error('recovery submission rejected');
    // Withheld row: pinned unsupported issuance, still unanswered.
    await seedHistoricalAssessmentIssuance(db, {
      group_id: model.row.id,
      issuance_id: 'iss_stream_withheld',
      now: NOW,
    });
    const date = streamLocalDate();
    const insertRow = (id: string, refId: string, position: number) =>
      db.insert(practice_stream_item).values({
        id,
        date,
        session_id: null,
        position,
        item_kind: 'question',
        ref_id: refId,
        source: 'on_demand',
        status: 'pending',
        reasoning: 'test',
        added_by: 'user',
      });
    // 11 admitted pinned issuances → 22 budgetable minutes > the 20-minute medium
    // default, so the budget trim must delete exactly one eligible tail.
    for (let i = 0; i < 11; i++) {
      await seedHistoricalAssessmentIssuance(db, {
        group_id: admitted.row.id,
        issuance_id: `iss_stream_eligible-${i}`,
        now: NOW,
      });
      await insertRow(`eligible-${i}`, `q-eligible-${i}`, i + 1);
    }
    await insertRow('recovery', model.row.id, 20);
    await insertRow('withheld', 'q-withheld', 21);
    const beforeIssuance = await db.select().from(assessment_issuance);
    const beforeSubmissions = await db.select().from(assessment_submission);

    const view = await getStream(db, date, { enforceBudget: true });
    const ids = view.items.map((item) => item.id);
    // The accepted submission keeps its stream row as the settlement/recovery
    // entry point; the unsupported unanswered row is never served as a question.
    expect(ids).toContain('recovery');
    expect(ids).not.toContain('withheld');
    const stored = await db.select().from(practice_stream_item);
    const storedIds = new Set(stored.map((row) => row.id));
    // Trim deletes only the eligible tail — never the recovery entry point and
    // never a stored unsupported row.
    expect(storedIds.has('recovery')).toBe(true);
    expect(storedIds.has('withheld')).toBe(true);
    expect(storedIds.has('eligible-10')).toBe(false);
    expect(stored.filter((row) => row.id.startsWith('eligible-'))).toHaveLength(10);
    // Serving reads and trimming never mutate issuance or accepted work.
    expect(await db.select().from(assessment_issuance)).toEqual(beforeIssuance);
    expect(await db.select().from(assessment_submission)).toEqual(beforeSubmissions);
  });

  // @invariant grading: an unanswered gate-refused paper slot is withheld from the learner answer surface while the accepted pinned submission keeps its projected DTO, and the read leaves the withheld issuance and its draft persisted untouched
  // @fails-if project the unsupported unanswered slot onto the answer surface or delete/rewrite its stored issuance/draft during the read; the slot-count or persistence assertions fail
  it('withholds unanswered unsupported paper slots while accepted pinned work keeps its history', async () => {
    const db = testDb();
    const s = await seed({ model: true });
    await seedHistoricalAssessmentIssuance(db, {
      group_id: s.row.id,
      issuance_id: 'iss_paper_withheld',
      now: NOW,
    });
    const slot = s.contract.response_spec.slots[0];
    if (slot.kind !== 'single_choice') throw new Error('expected choice');
    const drafted = await saveResponseDraft(db, {
      issuance_id: 'iss_paper_withheld',
      response_set: {
        entries: [
          { slot_id: slot.slot_id, kind: 'choice', option_ids: [slot.options[0].option_id] },
        ],
      },
      now: NOW,
    });
    if (drafted.status !== 'saved') throw new Error('withheld draft rejected');
    const [paperRow] = await db
      .insert(artifact)
      .values({
        id: 'paper-gate',
        type: 'tool_quiz',
        title: 'gate',
        intent_source: 'review_plan',
        source: 'ai_generated',
        created_at: NOW,
        updated_at: NOW,
      })
      .returning();
    const questionMeta = {
      kind: s.row.kind,
      difficulty: s.row.difficulty,
      knowledge_ids: s.row.knowledge_ids,
      parent_question_id: s.row.parent_question_id,
      part_index: s.row.part_index,
    };
    const binding = PaperAssessmentBinding.parse({
      version: 1,
      paper_id: paperRow.id,
      session_id: 'gate-session',
      started_at: NOW.toISOString(),
      slots: [
        {
          question_id: s.row.id,
          part_ref: null,
          section_index: 0,
          knowledge_focus: [],
          feedback_policy: 'immediate',
          question_meta: questionMeta,
          issuance_id: 'iss_paper_withheld',
          evaluation_group_id: 'eg_withheld',
          idempotency_key: 'k_withheld',
        },
        {
          question_id: s.row.id,
          part_ref: null,
          section_index: 0,
          knowledge_focus: [],
          feedback_policy: 'immediate',
          question_meta: questionMeta,
          issuance_id: s.issued.issuance.issuance_id,
          evaluation_group_id: 'eg_accepted',
          idempotency_key: 'k_accepted',
        },
      ],
    });
    const detail = await getFrozenPaperDetail(db, paperRow, binding, 'started');
    const slots = detail.sections.flatMap((sec) => sec.slots);
    // The unsupported unanswered slot is withheld from the answer surface; the
    // accepted submission keeps its projected DTO/history for recovery.
    expect(slots).toHaveLength(1);
    expect(slots[0].assessment?.issuance_id).toBe(s.issued.issuance.issuance_id);
    expect(slots[0].assessment?.response_set).toEqual(s.saved.submission.response_set);
    expect(slots[0].assessment?.practice_dto).toBeDefined();
    // Stored bytes survive the read-side gate: withheld issuance and its draft
    // remain persisted untouched.
    expect(
      (await db.select().from(assessment_issuance)).some(
        (row) => row.issuance_id === 'iss_paper_withheld',
      ),
    ).toBe(true);
    expect(
      (await db.select().from(assessment_response_draft)).map((row) => row.issuance_id),
    ).toEqual(['iss_paper_withheld']);
  });
});

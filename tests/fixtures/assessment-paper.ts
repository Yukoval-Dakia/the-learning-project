import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createPaperReviewSession } from '@/capabilities/practice/api/paper-session-create';
import { readPaperAssessmentBinding } from '@/capabilities/practice/server/assessment/paper-issuance';
import { withFrozenPaperReopen } from '@/capabilities/practice/server/assessment/paper-session-transition';
import { getIssuanceState } from '@/capabilities/practice/server/assessment/submit';
import {
  activateSubmissionCandidate,
  evaluateSubmission,
} from '@/capabilities/practice/server/judge/evaluate-submission';
import {
  type PaperSubmitSlotInput,
  submitPaperSlot,
} from '@/capabilities/practice/server/paper-submit';
import { Artifact } from '@/core/schema';
import type { SlotResponseT } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import {
  artifact,
  evaluation,
  evaluation_effective_head,
  event,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import {
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { Review } from '@/server/session';

/** Real publication/opening for migrated fixtures; never freezes lazily at submit time. */
export async function startFrozenPaperFixture(db: Db, paperId: string) {
  const [paper] = await db.select().from(artifact).where(eq(artifact.id, paperId));
  if (!paper) throw new Error('paper fixture missing');
  const state = Artifact.parse(paper).tool_state;
  const ids = [
    ...new Set([
      ...(state?.question_ids ?? []),
      ...(state?.sections ?? []).flatMap((section) =>
        section.assignments.map((a) => a.question_id),
      ),
    ]),
  ];
  for (const id of ids) {
    const [row] = await db.select().from(question).where(eq(question.id, id));
    if (!row) throw new Error(`question fixture missing: ${id}`);
    const rootId = row.parent_question_id ?? row.id;
    const [published] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, rootId));
    if (published?.current_revision_id) continue;
    const [root] = await db.select().from(question).where(eq(question.id, rootId));
    if (!root) throw new Error('shared parent fixture missing');
    const children = await db
      .select()
      .from(question)
      .where(eq(question.parent_question_id, rootId));
    const contract = children.length
      ? normalizeQuestionGroupToContract(root, children)
      : normalizeQuestionRowToContract(root);
    const result = await publishQuestionGroup(db, {
      group_id: rootId,
      contract,
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      availability: 'general_pool',
      actorRef: 'test:paper-publication',
      now: new Date(),
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'official',
          verification: { structural_check_passed: true, independent_verification: null },
          model_slice: null,
        },
      },
    });
    if (result.status !== 'published')
      throw new Error(`fixture publication failed: ${result.status}`);
  }
  return createPaperReviewSession(paperId);
}

/** Translate historical test input into the actual issued response shape, not a scoring mock. */
export async function paperFixtureAssessment(
  db: Db,
  sessionId: string,
  questionId: string,
  text: string,
  partRef?: string | null,
  images: string[] = [],
) {
  const binding = await readPaperAssessmentBinding(db, sessionId);
  const bound = binding?.slots.find(
    (slot) => slot.question_id === questionId && slot.part_ref === (partRef ?? null),
  );
  if (!bound) throw new Error('test must open a frozen paper before submitting');
  const state = await getIssuanceState(db, bound.issuance_id);
  const slots =
    state.practice_dto?.response_spec.slots.filter((slot) => slot.kind !== 'table') ?? [];
  if (slots.length !== 1)
    throw new Error('fixture text input must identify exactly one response slot');
  const slot = slots[0];
  let entry: SlotResponseT;
  switch (slot.kind) {
    case 'text':
      entry = { slot_id: slot.slot_id, kind: 'text', text_md: text };
      break;
    case 'open_response':
      entry = { slot_id: slot.slot_id, kind: 'open', text_md: text, evidence: [] };
      break;
    case 'single_choice':
    case 'multi_choice': {
      const selected = slot.options.filter(
        (option) => option.label === text || option.text === text,
      );
      if (text && selected.length !== 1)
        throw new Error(`test choice does not identify a published option: ${text}`);
      entry = {
        slot_id: slot.slot_id,
        kind: 'choice',
        option_ids: selected.map((option) => option.option_id),
      };
      break;
    }
    case 'numeric':
      entry = {
        slot_id: slot.slot_id,
        kind: 'numeric',
        raw_input: text,
        value: text.trim() && Number.isFinite(Number(text)) ? Number(text) : null,
      };
      break;
    case 'formula':
      entry = { slot_id: slot.slot_id, kind: 'formula', latex: text };
      break;
    default:
      throw new Error(`fixture needs an explicit native response for ${slot.kind}`);
  }
  return {
    issuance_id: bound.issuance_id,
    evaluation_group_id: bound.evaluation_group_id,
    idempotency_key: bound.idempotency_key,
    response_set: { entries: [entry] },
    group_evidence: images.map((assetId) => ({
      target: { scope: 'all_units' as const },
      evidence: {
        evidence_id: `evidence_${assetId}`,
        kind: 'image' as const,
        asset: {
          asset_id: assetId,
          digest: `sha256:${createHash('sha256').update(assetId).digest('hex')}`,
        },
        mime_type: 'image/png',
        bytes: 1024,
        uploaded_at: '2026-10-04T00:00:00.000Z',
      },
    })),
  };
}

export async function submitPaperFixture(input: PaperSubmitSlotInput, db: Db) {
  return submitPaperSlot(
    {
      ...input,
      assessment:
        input.assessment ??
        (await paperFixtureAssessment(
          db,
          input.sessionId,
          input.questionId,
          input.answerMd,
          input.partRef,
          input.answerImageRefs,
        )),
    },
    db,
  );
}

/** Explicitly admitted offline model task for paper driver tests, never a live provider call. */
export async function publishPaperModelFixture(db: Db, questionId: string) {
  const [row] = await db.select().from(question).where(eq(question.id, questionId));
  if (!row) throw new Error('model question fixture missing');
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, questionId));
  const [revision] = lifecycle?.current_revision_id
    ? await db
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
    : [];
  const contract = revision
    ? {
        integrity_digest: revision.integrity_digest,
        structure: revision.structure,
        response_spec: revision.response_spec,
        scoring_basis: revision.scoring_basis,
        execution_plan: revision.execution_plan,
      }
    : normalizeQuestionRowToContract(row);
  for (const unit of contract.scoring_basis.units) {
    if (unit.criterion.kind === 'rule_reference' && unit.criterion.probe_spec) continue;
    unit.criterion = {
      kind: 'rule_reference',
      rule_id: `${unit.scoring_unit_id}:rule`,
      source: 'official',
      statement_md: row.reference_md ?? 'No reference supplied',
    };
  }
  for (const assignment of contract.execution_plan.assignments) {
    assignment.executor = {
      kind: 'model_executor',
      task_kind: 'AssessmentRuleJudgeTask',
      admitted_slice_id: 'offline-paper-fixture-slice',
      max_cost_usd_micros: 1000,
    };
  }
  contract.integrity_digest = contractIntegrityDigest(contract);
  const published = await publishQuestionGroup(db, {
    group_id: row.id,
    contract,
    expectedCurrentRevision: lifecycle?.current_revision_id ?? null,
    expectedAdmissionGeneration: lifecycle?.scoring_admission_generation ?? null,
    availability: 'general_pool',
    actorRef: 'test:paper-model',
    now: new Date(),
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: {
          slice_id: 'offline-paper-fixture-slice',
          holdout_cases: 35,
          severe_errors_observed: 0,
          per_criterion_agreement: 1,
          pipeline_coverage: 1,
        },
      },
    },
  });
  if (published.status !== 'published')
    throw new Error(`fixture publication failed: ${published.status}`);
  return contract;
}

export async function reopenFrozenPaperFixture(db: Db, sessionId: string) {
  return withFrozenPaperReopen(db, sessionId, (tx) =>
    Review.reopenAbandonedReviewSession(tx, sessionId),
  );
}

/** Append a real correction and activate it with the current-head CAS. */
export async function correctPaperFixture(db: Db, attemptId: string, points: number) {
  const [anchor] = await db.select().from(event).where(eq(event.id, attemptId));
  const submissionId = anchor?.payload.submission_id;
  const groupId = anchor?.payload.evaluation_group_id;
  const issuanceId = anchor?.payload.issuance_id;
  if (
    typeof submissionId !== 'string' ||
    typeof groupId !== 'string' ||
    typeof issuanceId !== 'string'
  )
    throw new Error('native attempt missing');
  const [head] = await db
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, groupId));
  if (!head.effective_evaluation_id) throw new Error('effective candidate absent');
  const [current] = await db
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, head.effective_evaluation_id));
  const candidate = await evaluateSubmission(db, {
    submission_id: submissionId,
    evaluation_group_id: groupId,
    evaluation_key: `test-correction:${attemptId}:${points}`,
    mode: 'manual_assert',
    provenance: { source: 'manual', assisted: false },
    asserted_unit_results: current.unit_results.map((unit) => ({
      scoring_unit_id: unit.scoring_unit_id,
      status: 'scored',
      points_awarded: points,
      scored_because: 'response',
      evidence_citations: [],
    })),
  });
  const activated = await activateSubmissionCandidate(
    db,
    {
      evaluation_id: candidate.record.evaluation_id,
      expected_effective_id: head.effective_evaluation_id,
      expected_generation: head.generation,
    },
    { actorRef: 'test:paper-teacher' },
  );
  if (activated.status !== 'activated') throw new Error(`correction failed: ${activated.status}`);
  return candidate.record;
}

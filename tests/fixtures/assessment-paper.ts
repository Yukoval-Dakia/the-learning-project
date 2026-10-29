import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { createPaperReviewSession } from '@/capabilities/practice/api/paper-session-create';
import {
  PaperAssessmentBinding,
  type PaperAssessmentBindingT,
  paperBindingId,
  readPaperAssessmentBinding,
} from '@/capabilities/practice/server/assessment/paper-issuance';
import { withFrozenPaperReopen } from '@/capabilities/practice/server/assessment/paper-session-transition';
import { getIssuanceState } from '@/capabilities/practice/server/assessment/submit';
import {
  activateSubmissionCandidate,
  evaluateSubmission,
} from '@/capabilities/practice/server/judge/evaluate-submission';
import { readPaperSections } from '@/capabilities/practice/server/paper-sections';
import {
  type PaperSubmitSlotInput,
  submitPaperSlot,
} from '@/capabilities/practice/server/paper-submit';
import * as Review from '@/capabilities/practice/server/review-session-lifecycle';
import { canonicalHash } from '@/core/migration/canonical';
import { Artifact } from '@/core/schema';
import type { SlotResponseT } from '@/core/schema/assessment';
import { projectPracticeIssuance } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import {
  artifact,
  evaluation,
  evaluation_effective_head,
  event,
  learning_session,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { revisionRowToContract } from '@/kernel/records/assessment-issuance';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import {
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { seedHistoricalAssessmentIssuance } from './historical-assessment-issuance';

/** Real publication/opening for migrated fixtures; never freezes lazily at submit time. */
export async function startFrozenPaperFixture(db: Db, paperId: string) {
  await publishPaperFixtureGroups(db, paperId);
  return createPaperReviewSession(paperId);
}

/**
 * Already-issued paper session for fixtures whose slots are no longer servable
 * (e.g. model-executor contracts). Mirrors createPaperReviewSession +
 * issuePaperAssessment, but writes the per-slot issuances and the frozen
 * binding event as historical rows — never new serving authority.
 */
export async function startHistoricalPaperFixture(db: Db, paperId: string) {
  await publishPaperFixtureGroups(db, paperId);
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: learning_session.id })
      .from(learning_session)
      .where(
        and(
          eq(learning_session.type, 'review'),
          eq(learning_session.artifact_id, paperId),
          inArray(learning_session.status, ['started', 'paused']),
        ),
      )
      .orderBy(desc(learning_session.created_at))
      .limit(1);
    if (existing[0]) return { sessionId: existing[0].id, created: false };

    const { sessionId } = await Review.startReviewSession(tx, { artifactId: paperId });
    const [session] = await tx
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    if (!session) throw new Error('historical paper session missing');
    const [paper] = await tx.select().from(artifact).where(eq(artifact.id, paperId));
    if (!paper) throw new Error('paper fixture missing');
    const state = Artifact.parse(paper).tool_state;
    const sections = readPaperSections(state);
    const slots = sections.length
      ? sections.flatMap((section, sectionIndex) =>
          section.assignments.map((a) => ({
            question_id: a.question_id,
            part_ref: a.part_ref ?? null,
            section_index: sectionIndex,
            knowledge_focus: section.knowledge_focus,
            feedback_policy: section.feedback_policy,
          })),
        )
      : (state?.question_ids ?? []).map((question_id) => ({
          question_id,
          part_ref: null,
          section_index: 0,
          knowledge_focus: [] as string[],
          feedback_policy: 'immediate',
        }));
    const seen = new Set<string>();
    const pending = [];
    for (const slot of slots) {
      const key = `${slot.question_id}::${slot.part_ref ?? ''}`;
      if (seen.has(key)) throw new Error('duplicate paper slot');
      seen.add(key);
      const [q] = await tx
        .select({
          id: question.id,
          parent_id: question.parent_question_id,
          kind: question.kind,
          difficulty: question.difficulty,
          knowledge_ids: question.knowledge_ids,
          part_index: question.part_index,
        })
        .from(question)
        .where(eq(question.id, slot.question_id));
      if (!q) throw new Error('paper question not found');
      pending.push({
        slot: {
          ...slot,
          question_meta: {
            kind: q.kind,
            difficulty: q.difficulty,
            knowledge_ids: q.knowledge_ids,
            parent_question_id: q.parent_id,
            part_index: q.part_index,
          },
        },
        groupId: q.parent_id ?? q.id,
      });
    }
    const issuedSlots = new Map<string, PaperAssessmentBindingT['slots'][number]>();
    for (const { slot, groupId } of [...pending].sort((a, b) =>
      a.groupId.localeCompare(b.groupId),
    )) {
      const [lifecycle] = await tx
        .select()
        .from(question_group_lifecycle)
        .where(eq(question_group_lifecycle.group_id, groupId));
      if (!lifecycle?.current_revision_id)
        throw new Error('paper question has no frozen published revision');
      const [revision] = await tx
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, lifecycle.current_revision_id));
      if (!revision) throw new Error('paper revision is unavailable');
      const partId = slot.part_ref ?? slot.question_id;
      const partIds = revision.structure.parts.some((part) => part.part_id === partId)
        ? [partId]
        : slot.part_ref === null && groupId === slot.question_id
          ? revision.structure.parts.map((part) => part.part_id)
          : [];
      if (!partIds.length) throw new Error('paper slot is outside published parts');
      const identity = canonicalHash({
        session_id: sessionId,
        started_at: session.started_at.toISOString(),
        question_id: slot.question_id,
        part_ref: slot.part_ref,
      });
      const issued = await seedHistoricalAssessmentIssuance(tx, {
        group_id: groupId,
        revision_id: revision.revision_id,
        part_ids: partIds,
        issuance_id: `iss_paper_${identity}`,
        container_occurrence_ref: `paper_${identity}`,
        now: session.started_at,
      });
      issuedSlots.set(`${slot.question_id}::${slot.part_ref ?? ''}`, {
        ...slot,
        issuance_id: issued.issuance.issuance_id,
        evaluation_group_id: `eg_paper_${identity}`,
        idempotency_key: `paper_${identity}`,
      });
    }
    const binding = PaperAssessmentBinding.parse({
      version: 1,
      paper_id: paperId,
      session_id: sessionId,
      started_at: session.started_at.toISOString(),
      slots: slots.map((slot) => issuedSlots.get(`${slot.question_id}::${slot.part_ref ?? ''}`)),
    });
    await writeEvent(tx, {
      id: paperBindingId(sessionId, session.started_at),
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:assessment_paper_issued',
      subject_kind: 'artifact',
      subject_id: paperId,
      outcome: null,
      payload: binding,
      created_at: session.started_at,
      ingest_at: session.started_at,
    });
    return { sessionId, created: true };
  });
}

async function publishPaperFixtureGroups(db: Db, paperId: string) {
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
  // YUK-1445 —— the serving gate correctly withholds practice_dto for NEW
  // serving on unservable (e.g. model-executor) contracts. For paper work that
  // was ALREADY issued (historical rows), the submitted response must still
  // bind to the REAL immutable frozen revision + issuance coordinates: rebuild
  // the public projection with the same production projector used inside
  // getIssuanceState (validateIssuanceBinding runs there and throws on any
  // revision/scope mismatch — an incomplete or wrong binding fails loudly).
  // No guessed answer key, no fabricated practice DTO or model admission; the
  // guard on new serving is untouched.
  let practice = state.practice_dto;
  if (practice == null) {
    if (state.issuance == null) throw new Error('fixture issuance state is missing');
    const [revRow] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, state.issuance.binding.revision_id))
      .limit(1);
    if (revRow == null) throw new Error('fixture pinned revision is unavailable');
    practice = projectPracticeIssuance(revisionRowToContract(revRow), state.issuance);
  }
  const slots = practice.response_spec.slots.filter((slot) => slot.kind !== 'table');
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

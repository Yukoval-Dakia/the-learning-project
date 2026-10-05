import { and, eq, inArray } from 'drizzle-orm';
import { EvaluationRecord, projectPracticeIssuance } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import {
  answer,
  type artifact,
  assessment_issuance,
  assessment_response_draft,
  assessment_submission,
  event,
  question_revision,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { resolveVerdictsForNativeAttempts } from '@/kernel/read-models/assessment-verdict';
import {
  batchResolveSubjectDisplayIds,
  resolveSubjectRenderNotation,
} from '@/kernel/read-models/subject-resolution';
import { projectEvaluationToJudgeResult } from '../judge/evaluation-authority';
import type { PaperDetailResult, PaperDetailSection, PaperDetailSlot } from '../paper-detail';
import { resolveKnowledgeNames } from '../practice-read';
import { issuanceRowToContract, revisionRowToContract } from './issue';
import type { PaperAssessmentBindingT } from './paper-issuance';
import { projectFrozenStudyContext } from './study-context';

/** All slots and disclosure rules come from the immutable opening receipt. */
export async function getFrozenPaperDetail(
  db: Db,
  paper: typeof artifact.$inferSelect,
  binding: PaperAssessmentBindingT,
  sessionStatus: string,
): Promise<PaperDetailResult> {
  const issuanceIds = binding.slots.map((slot) => slot.issuance_id);
  const issued = issuanceIds.length
    ? await db
        .select({ issuance: assessment_issuance, revision: question_revision })
        .from(assessment_issuance)
        .innerJoin(
          question_revision,
          eq(question_revision.revision_id, assessment_issuance.revision_id),
        )
        .where(inArray(assessment_issuance.issuance_id, issuanceIds))
    : [];
  const issuedById = new Map(issued.map((row) => [row.issuance.issuance_id, row]));
  const drafts = issuanceIds.length
    ? await db
        .select()
        .from(assessment_response_draft)
        .where(inArray(assessment_response_draft.issuance_id, issuanceIds))
    : [];
  const submissions = issuanceIds.length
    ? await db
        .select()
        .from(assessment_submission)
        .where(inArray(assessment_submission.issuance_id, issuanceIds))
    : [];
  const submissionByIssuance = new Map(submissions.map((sub) => [sub.issuance_id, sub]));
  const draftByIssuance = new Map(drafts.map((draft) => [draft.issuance_id, draft]));
  const captures = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.session_id, binding.session_id),
        eq(event.action, 'experimental:assessment_attempt'),
      ),
    );
  const captureBySubmission = new Map(
    captures.map((capture) => [capture.payload.submission_id, capture]),
  );
  const verdicts = await resolveVerdictsForNativeAttempts(db, captures);
  const answerRows = await db
    .select()
    .from(answer)
    .where(eq(answer.session_id, binding.session_id));
  const answerByEvent = new Map(
    answerRows.filter((row) => row.event_id).map((row) => [row.event_id, row]),
  );
  const focusIds = [...new Set(binding.slots.flatMap((slot) => slot.knowledge_focus))];
  const names = await resolveKnowledgeNames(db, focusIds);
  const notationIds = await batchResolveSubjectDisplayIds(
    db,
    binding.slots.map((slot) => ({
      id: slot.question_id,
      knowledge_ids: slot.question_meta.knowledge_ids,
    })),
  );
  const sections = new Map<number, PaperDetailSection>();
  let pos = 0,
    right = 0,
    wrong = 0;
  for (const slot of binding.slots) {
    const frozen = issuedById.get(slot.issuance_id);
    if (!frozen) throw new ApiError('corrupt_state', 'paper opening receipt has no issuance', 409);
    const dto = projectPracticeIssuance(
      revisionRowToContract(frozen.revision),
      issuanceRowToContract(frozen.issuance),
    );
    const original = submissionByIssuance.get(slot.issuance_id);
    const draft = draftByIssuance.get(slot.issuance_id);
    const capture = original ? captureBySubmission.get(original.submission_id) : undefined;
    const frozenAnswer = capture ? answerByEvent.get(capture.id) : undefined;
    const context = projectFrozenStudyContext(frozen.revision, frozen.issuance, slot.question_id);
    const effective = capture ? verdicts.get(capture.id)?.effective : null;
    const grade = effective?.scoring_basis
      ? projectEvaluationToJudgeResult(
          EvaluationRecord.parse(effective.row),
          effective.scoring_basis,
        )
      : null;
    const visible =
      slot.feedback_policy !== 'judge_now_show_later' || sessionStatus === 'completed';
    let submission: PaperDetailSlot['slot_state']['submission'] = null;
    if (original && capture) {
      pos++;
      if (visible) {
        if (grade?.coarse_outcome === 'correct' || grade?.coarse_outcome === 'partial') right++;
        else if (grade?.coarse_outcome === 'incorrect') wrong++;
      }
      const common = {
        submitted: true as const,
        answer_md: frozenAnswer?.content_md ?? '',
        answer_image_refs: frozenAnswer?.image_refs ?? [],
      };
      submission = visible
        ? {
            ...common,
            visible_to_user: true,
            outcome: grade?.coarse_outcome ?? 'unsupported',
            score: grade?.score ?? null,
            feedback_md: grade?.feedback_md ?? null,
            reference_md: context.reference_md,
          }
        : { ...common, visible_to_user: false, feedback_buffered: true };
    }
    const detail: PaperDetailSlot = {
      question_id: slot.question_id,
      part_ref: slot.part_ref,
      section_index: slot.section_index,
      knowledge_focus: slot.knowledge_focus,
      question: {
        id: slot.question_id,
        kind: slot.question_meta.kind,
        prompt_md: context.prompt_md,
        notation: resolveSubjectRenderNotation(notationIds.get(slot.question_id) ?? null),
        choices_md: null,
        difficulty: slot.question_meta.difficulty,
        parent_question_id: slot.question_meta.parent_question_id,
        part_index: slot.question_meta.part_index,
        image_refs: dto.materials.filter((m) => m.kind === 'figure').map((m) => m.asset_id),
      },
      assessment: {
        issuance_id: slot.issuance_id,
        evaluation_group_id: slot.evaluation_group_id,
        idempotency_key: slot.idempotency_key,
        save_epoch: draft?.save_epoch ?? 0,
        practice_dto: dto,
        response_set: original?.response_set ?? draft?.response_set ?? { entries: [] },
        group_evidence: original?.group_evidence ?? draft?.group_evidence ?? [],
      },
      slot_state: { draft: null, submission },
    };
    let section = sections.get(slot.section_index);
    if (!section) {
      section = {
        section_index: slot.section_index,
        knowledge_focus: slot.knowledge_focus,
        knowledge_focus_names: slot.knowledge_focus.map((id) => names.get(id) ?? id),
        feedback_policy: slot.feedback_policy,
        slots: [],
      };
      sections.set(slot.section_index, section);
    }
    section.slots.push(detail);
  }
  return {
    artifact_id: paper.id,
    title: paper.title,
    generation_status: paper.generation_status,
    intent_source: paper.intent_source,
    session: { id: binding.session_id, status: sessionStatus, pos, right, wrong },
    sections: [...sections.values()].sort((a, b) => a.section_index - b.section_index),
    is_flat_fallback: false,
  };
}

// Decides every unit a blind solve could not settle, using the task-configured adjudicator.
// It never selects a fallback model; the evidence records which route actually answered.
import { canonicalProviderName } from '@/ai/task-spec';
import { getTaskOverride } from '@/core/config/store';
import type { Db } from '@/db/client';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import type { SubjectProfile } from '@/subjects/profile';
import {
  AdmissionAdjudication,
  AdmissionAdjudicationInput,
  type AdmissionMarkingStateT,
  questionAdmissionAdjudicateTaskSpec,
} from '../../tasks/question-admission-adjudicate';
import { AdmissionParseFailure, runAdmissionAttempts } from './attempt';
import type { QuestionAdmissionDefinition } from './contract';
import {
  type AdmissionImage,
  type AdmissionSolveReceipt,
  type BlindSolveResult,
  admissionWireInput,
  sealTaskRun,
  solverParts,
  solverUnits,
} from './solve';
import { AdmissionNotSent } from './stages';

export const ADJUDICATION_TASK_KIND = 'QuestionAdmissionAdjudicateTask';

function candidateAnswerForms(definition: QuestionAdmissionDefinition, solve: BlindSolveResult) {
  return definition.units.flatMap((unit) => {
    if (unit.unit_kind !== 'blank') return [];
    const texts = new Set<string>();
    const answer = solve.output.units.find(
      (u) => u.scoring_unit_id === unit.scoring_unit_id,
    )?.answer;
    if (answer?.kind === 'blank_text') for (const text of answer.accepted) texts.add(text);
    const criterion = unit.seeded_criterion;
    if (criterion?.kind === 'blank_key' && criterion.key.kind === 'text')
      for (const text of criterion.key.accepted) texts.add(text);
    return texts.size
      ? [
          {
            scoring_unit_id: unit.scoring_unit_id,
            forms: [...texts].map((text, index) => ({ form_id: `form_${index}`, text })),
          },
        ]
      : [];
  });
}

export async function adjudicateAdmission(
  db: Db,
  definition: QuestionAdmissionDefinition,
  solve: BlindSolveResult,
  figureState: 'none_referenced' | 'missing_referenced' | 'unreadable' | 'available',
  runTask: BoundRunTaskTextFn,
  subjectProfile?: SubjectProfile,
  images?: readonly AdmissionImage[],
  markings: readonly AdmissionMarkingStateT[] = [],
) {
  const config = getTaskOverride(ADJUDICATION_TASK_KIND);
  if (!config?.provider || !config.model || config.overrideGlobalPin !== true) {
    throw new AdmissionNotSent();
  }
  const answerForms = candidateAnswerForms(definition, solve);
  const payload = AdmissionAdjudicationInput.parse({
    parts: solverParts(definition),
    units: solverUnits(definition, { exposePrinted: true }),
    figure_state: figureState,
    markings,
    solve: { units: solve.output.units.map(({ prior: _prior, ...unit }) => unit) },
    author_evidence:
      definition.original_units ??
      definition.units.map((u) => ({
        scoring_unit_id: u.scoring_unit_id,
        criterion: u.seeded_criterion,
      })),
    source_answers: definition.source_answers,
    ...(answerForms.length ? { answer_forms: answerForms } : {}),
  });
  const wire = admissionWireInput(payload, images);
  const attempt = await runAdmissionAttempts(
    db,
    () =>
      runTask(ADJUDICATION_TASK_KIND, wire, {
        judgeRetryPolicy: 'none',
        budgetOverride: { maxIterations: 1 },
        ...(subjectProfile ? { subjectProfile } : {}),
      }),
    async (result) => {
      try {
        if (result.structured_output == null)
          throw new Error('Missing structured adjudication output');
        const output = AdmissionAdjudication.parse(result.structured_output);
        const formReviews: {
          scoring_unit_id: string;
          correct: string[];
          incorrect: { text: string; reason_md: string }[];
        }[] = [];
        const expected = new Set(payload.units.map((u) => u.scoring_unit_id));
        const seen = new Set<string>();
        for (const verdict of output.per_unit) {
          if (!expected.has(verdict.scoring_unit_id) || seen.has(verdict.scoring_unit_id))
            throw new Error('Adjudication unit coverage mismatch');
          seen.add(verdict.scoring_unit_id);
          if (verdict.verdict !== 'pass') continue;
          const unit = payload.units.find((u) => u.scoring_unit_id === verdict.scoring_unit_id);
          if (!unit) throw new Error('Adjudication returned unknown unit');
          const forms =
            payload.answer_forms?.find(
              (candidate) => candidate.scoring_unit_id === unit.scoring_unit_id,
            )?.forms ?? [];
          const reviewed = new Set<string>();
          const review: (typeof formReviews)[number] = {
            scoring_unit_id: unit.scoring_unit_id,
            correct: [],
            incorrect: [],
          };
          for (const decision of verdict.form_verdicts ?? []) {
            const form = forms.find((form) => form.form_id === decision.form_id);
            if (!form || reviewed.has(form.form_id))
              throw new Error('Adjudication answer-form coverage mismatch');
            reviewed.add(form.form_id);
            if (decision.verdict === 'correct') review.correct.push(form.text);
            else review.incorrect.push({ text: form.text, reason_md: decision.reason_md });
          }
          if (reviewed.size !== forms.length)
            throw new Error('Adjudication omitted candidate answer forms');
          if (forms.length) formReviews.push(review);
          const key = verdict.decided_key;
          if (
            unit.kind === 'free' &&
            (key.kind !== 'free' || verdict.ai_grading_sufficient !== true)
          )
            throw new Error('Free unit pass requires sufficient AI grading and rubric');
          if (unit.kind === 'blank' && key.kind !== 'blank_text' && key.kind !== 'blank_numeric')
            throw new Error('Blank adjudication key kind mismatch');
          if (unit.kind === 'select') {
            if (
              key.kind !== 'select' ||
              new Set(key.item_ids).size !== key.item_ids.length ||
              (unit.select?.pick === 'one' && key.item_ids.length !== 1) ||
              key.item_ids.some((id) => !unit.select?.items.some((i) => i.item_id === id))
            )
              throw new Error('Adjudication key outside declared selection universe');
          }
        }
        if (seen.size !== expected.size) throw new Error('Adjudication omitted units');
        return { output, result, formReviews };
      } catch (error) {
        throw new AdmissionParseFailure(error instanceof Error ? error.message : String(error));
      }
    },
  );
  const { output, result, formReviews } = attempt.value;
  return {
    output,
    form_reviews: formReviews,
    attempt_run_ids: attempt.taskRunIds,
    receipt: await sealTaskRun(db, wire, result, output, ADJUDICATION_TASK_KIND),
  };
}

/**
 * Who answered, read off the sealed receipts rather than configuration: the same
 * provider+model as the blind solve means no second model looked at the question, and a
 * route other than the task's declared adjudicator is a fallback.
 */
export function adjudicatorIdentity(
  solver: Pick<AdmissionSolveReceipt, 'provider' | 'model'>,
  adjudicator: Pick<AdmissionSolveReceipt, 'provider' | 'model'>,
) {
  const declared = questionAdmissionAdjudicateTaskSpec.definition;
  const provider = canonicalProviderName(adjudicator.provider);
  return {
    adjudicator_context:
      canonicalProviderName(solver.provider) === provider && solver.model === adjudicator.model
        ? ('same_model_as_solver' as const)
        : ('independent_model' as const),
    route_role:
      provider === canonicalProviderName(declared.defaultProvider) &&
      adjudicator.model === declared.defaultModel
        ? ('primary' as const)
        : ('fallback' as const),
  };
}

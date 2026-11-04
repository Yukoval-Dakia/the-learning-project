// Resolves disagreements using the task-configured adjudicator; never selects a fallback model.
import { getTaskOverride } from '@/core/config/store';
import type { Db } from '@/db/client';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import type { SubjectProfile } from '@/subjects/profile';
import {
  AdmissionAdjudication,
  AdmissionAdjudicationInput,
} from '../../tasks/question-admission-adjudicate';
import { AdmissionParseFailure, runAdmissionAttempts } from './attempt';
import type { QuestionAdmissionDefinition } from './contract';
import {
  type AdmissionImage,
  type DualSolveResult,
  admissionWireInput,
  sealTaskRun,
  solverParts,
  solverUnits,
} from './solve';

export const ADJUDICATION_TASK_KIND = 'QuestionAdmissionAdjudicateTask';

export async function adjudicateAdmission(
  db: Db,
  definition: QuestionAdmissionDefinition,
  solve: DualSolveResult,
  figureState: 'none_referenced' | 'missing_referenced' | 'unreadable' | 'available',
  runTask: BoundRunTaskTextFn,
  subjectProfile?: SubjectProfile,
  images?: readonly AdmissionImage[],
) {
  const config = getTaskOverride(ADJUDICATION_TASK_KIND);
  if (!config?.provider || !config.model || config.overrideGlobalPin !== true) {
    throw new Error(
      'Admission adjudicator requires task.QuestionAdmissionAdjudicateTask.provider/model and override_global_pin=true',
    );
  }
  const payload = AdmissionAdjudicationInput.parse({
    parts: solverParts(definition),
    units: solverUnits(definition, 0, { exposePrinted: true }),
    figure_state: figureState,
    solves: solve.outputs,
    author_evidence:
      definition.original_units ??
      definition.units.map((u) => ({
        scoring_unit_id: u.scoring_unit_id,
        criterion: u.seeded_criterion,
      })),
    source_answers: definition.source_answers,
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
        const expected = new Set(payload.units.map((u) => u.scoring_unit_id));
        const seen = new Set<string>();
        for (const verdict of output.per_unit) {
          if (!expected.has(verdict.scoring_unit_id) || seen.has(verdict.scoring_unit_id))
            throw new Error('Adjudication unit coverage mismatch');
          seen.add(verdict.scoring_unit_id);
          if (verdict.verdict !== 'pass') continue;
          const unit = payload.units.find((u) => u.scoring_unit_id === verdict.scoring_unit_id);
          if (!unit) throw new Error('Adjudication returned unknown unit');
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
        return { output, result };
      } catch (error) {
        throw new AdmissionParseFailure(error instanceof Error ? error.message : String(error));
      }
    },
  );
  const { output, result } = attempt.value;
  return {
    output,
    attempt_run_ids: attempt.taskRunIds,
    receipt: await sealTaskRun(db, wire, result, output, ADJUDICATION_TASK_KIND),
  };
}

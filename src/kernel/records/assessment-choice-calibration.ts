import {
  ChoiceMethodCalibration,
  type ChoiceMethodCalibrationT,
} from '@/core/schema/assessment/choice-entry';
import { projectPracticeIssuance } from '@/core/schema/assessment/dto';
import { evaluateSubmissionCore } from '@/core/schema/assessment/evaluation';
import { isPublicSharedMaterial } from '@/core/schema/assessment/materials';
import type { PublishedQuestionRevisionT } from '@/core/schema/assessment/revision';
import { sha256CanonicalJson } from '@/kernel/canonical-json';

export const assessmentDigest = (value: unknown): string => `sha256:${sha256CanonicalJson(value)}`;

function choiceMethod(revision: PublishedQuestionRevisionT) {
  const [slot] = revision.response_spec.slots;
  const [unit] = revision.scoring_basis.units;
  const [assignment] = revision.execution_plan.assignments;
  if (
    revision.response_spec.slots.length !== 1 ||
    slot?.kind !== 'single_choice' ||
    revision.scoring_basis.units.length !== 1 ||
    unit?.criterion.kind !== 'option_set_key' ||
    unit.criterion.accepted_option_ids.length !== 1 ||
    unit.points == null ||
    unit.points <= 0 ||
    revision.execution_plan.assignments.length !== 1 ||
    assignment?.executor.kind !== 'deterministic' ||
    assignment.executor.comparator !== 'exact_option_set' ||
    assignment.scoring_unit_ids.length !== 1 ||
    assignment.scoring_unit_ids[0] !== unit.scoring_unit_id
  ) {
    throw new Error(
      'choice entry requires one single-choice unit with printed points and exact_option_set',
    );
  }
  const accepted = unit.criterion.accepted_option_ids[0];
  if (!slot.options.some((option) => option.option_id === accepted)) {
    throw new Error('choice entry key does not reference an existing stable option id');
  }
  return { slot, unit, assignment, accepted, points: unit.points };
}

function frozenProbes(revision: PublishedQuestionRevisionT) {
  const { slot, points, accepted } = choiceMethod(revision);
  const order = slot.options.map((option) => option.option_id);
  return [
    ...order.map((option_id) => ({
      probe_id: `select:${option_id}`,
      option_order: order,
      selected_option_ids: [option_id],
      expected_points: option_id === accepted ? points : 0,
    })),
    {
      probe_id: 'shuffled-correct',
      option_order: [...order].reverse(),
      selected_option_ids: [accepted],
      expected_points: points,
    },
    {
      probe_id: 'explicit-blank',
      option_order: order,
      selected_option_ids: [],
      expected_points: 0,
    },
  ];
}

export function choiceCalibrationFingerprints(revision: PublishedQuestionRevisionT) {
  const { unit, assignment } = choiceMethod(revision);
  return {
    question_input_digest: assessmentDigest({
      parts: revision.structure.parts.map((part) => ({
        ...part,
        material_ids: part.material_ids.filter((id) =>
          revision.structure.materials.some(
            (material) => material.material_id === id && isPublicSharedMaterial(material),
          ),
        ),
      })),
      materials: revision.structure.materials.filter(isPublicSharedMaterial),
      response_spec: revision.response_spec,
    }),
    method_digest: assessmentDigest({
      method_version: 'exact-option-set@1',
      unit,
      assignment,
      aggregation: revision.scoring_basis.aggregation,
      blank_scores_zero: revision.scoring_basis.blank_scores_zero,
    }),
  };
}

/** Freeze all probes before invoking the same pure evaluator used by persisted submissions. */
export async function calibrateChoiceMethod(
  revision: PublishedQuestionRevisionT,
  solves: ChoiceMethodCalibrationT['solves'],
  now: Date,
): Promise<ChoiceMethodCalibrationT> {
  if (solves[0].task_run_id === solves[1].task_run_id)
    throw new Error('choice solves must be independent task runs');
  const { slot, unit } = choiceMethod(revision);
  const frozen = frozenProbes(revision);
  const probe_digest = assessmentDigest(frozen);
  const probes: ChoiceMethodCalibrationT['probes'] = [];
  for (const probe of frozen) {
    const id = `calibration:${probe.probe_id}`;
    // Exercise public issued order as well as stable-ID scoring; never translate display letters.
    const dto = projectPracticeIssuance(revision, {
      issuance_id: id,
      issued_at: now.toISOString(),
      claim: { policy: 'unbounded', status: 'unclaimed', claimed_by_ref: null },
      binding: {
        revision_id: revision.revision_id,
        part_ids: revision.structure.parts.map((part) => part.part_id),
        material_bindings: revision.structure.materials.map((material) => ({
          material_id: material.material_id,
          asset_digest: material.asset.digest,
        })),
        option_order: [{ slot_id: slot.slot_id, option_ids: probe.option_order }],
      },
    });
    const [served] = dto.response_spec.slots;
    if (
      served?.kind !== 'single_choice' ||
      served.options.some((option, i) => option.option_id !== probe.option_order[i])
    ) {
      throw new Error('calibration issued option order was not preserved');
    }
    const outcome = await evaluateSubmissionCore({
      evaluation_id: id,
      revision,
      attempt: 1,
      submission: {
        submission_id: id,
        issuance_id: id,
        revision_id: revision.revision_id,
        evaluation_group_id: id,
        response_set: {
          entries: [
            { kind: 'choice', slot_id: slot.slot_id, option_ids: probe.selected_option_ids },
          ],
        },
        group_evidence: [],
        idempotency_key: id,
        submitted_at: now.toISOString(),
      },
    });
    const result = outcome.record.unit_results.find(
      (result) => result.scoring_unit_id === unit.scoring_unit_id,
    );
    const actual_points = result?.status === 'scored' ? result.points_awarded : null;
    probes.push({
      ...probe,
      actual_points,
      passed: outcome.model_units_invoked === 0 && actual_points === probe.expected_points,
    });
  }
  return ChoiceMethodCalibration.parse({
    policy_id: 'choice-entry@1',
    revision_digest: revision.integrity_digest,
    ...choiceCalibrationFingerprints(revision),
    solves,
    scoring_unit_id: unit.scoring_unit_id,
    method_version: 'exact-option-set@1',
    method_digest: choiceCalibrationFingerprints(revision).method_digest,
    probe_digest,
    probes,
    calibrated_at: now.toISOString(),
  });
}

export function validateChoiceCalibration(
  revision: PublishedQuestionRevisionT,
  evidence: ChoiceMethodCalibrationT,
): void {
  const parsed = ChoiceMethodCalibration.parse(evidence);
  const { unit } = choiceMethod(revision);
  const fingerprints = choiceCalibrationFingerprints(revision);
  const definitions = parsed.probes.map(
    ({ actual_points: _actual, passed: _passed, ...probe }) => probe,
  );
  if (
    parsed.revision_digest !== revision.integrity_digest ||
    parsed.scoring_unit_id !== unit.scoring_unit_id ||
    parsed.method_digest !== fingerprints.method_digest ||
    parsed.question_input_digest !== fingerprints.question_input_digest ||
    parsed.solves[0].task_run_id === parsed.solves[1].task_run_id ||
    parsed.probe_digest !== assessmentDigest(definitions) ||
    parsed.probe_digest !== assessmentDigest(frozenProbes(revision)) ||
    parsed.probes.some((probe) => !probe.passed || probe.actual_points !== probe.expected_points)
  ) {
    throw new Error('choice calibration does not cover this frozen question and method');
  }
}

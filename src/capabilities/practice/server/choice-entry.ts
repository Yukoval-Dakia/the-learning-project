import { createId } from '@paralleldrive/cuid2';
import { eq, inArray } from 'drizzle-orm';
import {
  ChoiceEntrySolveInput,
  type ChoiceEntrySolveInputT,
  ChoiceEntrySolveOutput,
  type ChoiceEntrySolveOutputT,
  SingleChoiceEntrySpec,
} from '@/core/schema/assessment/choice-entry';
import { validateQuestionPresentation } from '@/core/schema/assessment/presentation';
import type { AdmissionEvidenceT } from '@/core/schema/assessment/publish';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import { StructuredQuestion } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import {
  ai_task_runs,
  question as questionTable,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import {
  assessmentDigest,
  calibrateChoiceMethod,
  validateChoiceCalibration,
} from '@/kernel/records/assessment-choice-calibration';
import { revisionRowToContract } from '@/kernel/records/assessment-issuance';
import { normalizeQuestionRowToContract } from '@/kernel/records/assessment-normalization';
import { sanitizeSourcedMarkup } from '@/server/questions/sourced-markup';
import { resolveSubjectProfile } from '@/subjects/profile';
import { parseTaskOutput } from '../tasks/parse-output';
import { type PracticeTaskRunFn, makePracticeTaskTextRunFn } from './task-runtime';

/** No source key, learner attempt, other solve or conversation history enters either request. */
export async function prepareSingleChoiceEntry(
  db: Db,
  input: {
    question_id: string;
    subject_id: string;
    question: SourcedQuestionT;
    printed_points: number;
  },
  runTask: PracticeTaskRunFn = makePracticeTaskTextRunFn(db),
) {
  const prompt_md = sanitizeSourcedMarkup(input.question.prompt_md);
  const choices = input.question.choices_md ?? [];
  if (
    input.question.kind !== 'choice' ||
    choices.length < 2 ||
    /如图|见图|下图|右图|左图|上图|图中|图所示/.test(prompt_md) ||
    /!\[[^\]]*\]\(|<img\b/i.test([prompt_md, ...choices].join('\n'))
  ) {
    throw new Error(
      'choice entry first slice requires a complete single-choice statement without figure dependencies',
    );
  }
  const request = ChoiceEntrySolveInput.parse({
    subject_id: input.subject_id,
    part_id: input.question_id,
    slot_id: `${input.question_id}::r`,
    scoring_unit_id: `${input.question_id}::u`,
    prompt_md,
    printed_points: input.printed_points,
    options: choices.map((text, i) => ({
      option_id: createId(),
      label: String.fromCharCode(65 + i),
      text: sanitizeSourcedMarkup(text),
    })),
  });
  const profile = resolveSubjectProfile(input.subject_id);
  async function solve(payload: ChoiceEntrySolveInputT) {
    // Each central runner invocation creates a new task/session. No sdkSession/replay is supplied.
    const result = await runTask('ChoiceEntrySolveTask', payload, { subjectProfile: profile });
    const output: ChoiceEntrySolveOutputT =
      result.structured_output === undefined
        ? parseTaskOutput(result.text, 'ChoiceEntrySolveTask', ChoiceEntrySolveOutput)
        : ChoiceEntrySolveOutput.parse(result.structured_output);
    const ids = new Set(payload.options.map((option) => option.option_id));
    const [accepted] = output.criterion.accepted_option_ids;
    if (
      !ids.has(accepted) ||
      output.distractors.length !== ids.size - 1 ||
      new Set(output.distractors.map((option) => option.option_id)).size !== ids.size - 1 ||
      output.distractors.some(
        (option) => !ids.has(option.option_id) || option.option_id === accepted,
      )
    ) {
      throw new Error(
        'independent choice solve did not identify the key and every distractor by stable ID',
      );
    }
    if (result.task_run_id == null) throw new Error('choice solve has no durable task run receipt');
    const [receipt] = await db
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, result.task_run_id))
      .limit(1);
    if (receipt?.status !== 'success' || receipt.task_kind !== 'ChoiceEntrySolveTask') {
      throw new Error('choice solve requires a successful real central task receipt');
    }
    return {
      output,
      seal: {
        task_run_id: receipt.id,
        provider: receipt.provider,
        model: receipt.model,
        input_digest: assessmentDigest(payload),
        output_digest: assessmentDigest(output),
      },
    };
  }
  const first = await solve(request);
  // Display permutation is independent of the stable identities. The second pass is blind to the first.
  const second = await solve({ ...request, options: [...request.options].reverse() });
  if (
    first.seal.task_run_id === second.seal.task_run_id ||
    first.output.criterion.accepted_option_ids[0] !== second.output.criterion.accepted_option_ids[0]
  ) {
    throw new Error('independent choice solves disagree; candidate remains unpublished');
  }
  const assessment = SingleChoiceEntrySpec.parse({
    kind: 'single_choice',
    criterion: first.output.criterion,
    printed_points: request.printed_points,
    presentation: first.output.presentation,
  });
  const structured = StructuredQuestion.parse({
    id: input.question_id,
    role: 'standalone',
    prompt_text: prompt_md,
    options: request.options,
    assessment,
    source: 'agent_edit',
    student_answer_present: false,
  });
  const question = {
    ...input.question,
    prompt_md,
    choices_md: request.options.map((option) => option.text),
    reference_md: first.output.worked_solution_md,
    rubric_json: null,
    judge_kind_override: null,
  };
  const contract = normalizeQuestionRowToContract({
    id: input.question_id,
    ...question,
    choices_md: question.choices_md,
    structured,
    source: 'web_sourced',
    figures: [],
  });
  if (
    contract.conversion_issues.length ||
    validateQuestionPresentation(
      assessment.presentation,
      contract.structure,
      contract.response_spec,
      contract.scoring_basis,
    ).length
  ) {
    throw new Error('choice entry structure or presentation binding is invalid');
  }
  const now = new Date();
  const calibration = await calibrateChoiceMethod(
    {
      ...contract,
      revision_id: `entry:${input.question_id}`,
      revision_ordinal: 1,
      published_at: now.toISOString(),
      supersedes_revision_id: null,
    },
    [first.seal, second.seal],
    now,
  );
  if (calibration.probes.some((probe) => !probe.passed))
    throw new Error('choice method failed its frozen calibration probes');
  const evidence: AdmissionEvidenceT = {
    marking_provenance: 'system_verified',
    model_slice: null,
    verification: {
      structural_check_passed: true,
      independent_verification: {
        passed: true,
        verifier: 'independent_model',
        verified_at: now.toISOString(),
      },
      note: 'Two blind central solves agree on the stable option ID; all frozen exact-option-set probes passed.',
    },
    calibration,
  };
  return { question, structured, evidence };
}

/** Reuse an entry proof during source verification; never re-interpret its solution prose as a key. */
export async function readVerifiedChoiceEntry(
  db: Db,
  input: {
    id: string;
    prompt_md: string;
    reference_md: string | null;
    choices_md: string[] | null;
  },
): Promise<
  { kind: 'not_entry' } | { kind: 'unavailable' } | { kind: 'verified'; task_run_ids: string[] }
> {
  const [row] = await db
    .select()
    .from(questionTable)
    .where(eq(questionTable.id, input.id))
    .limit(1);
  if (row?.structured?.assessment == null) return { kind: 'not_entry' };
  if (
    row.prompt_md !== input.prompt_md ||
    row.reference_md !== input.reference_md ||
    assessmentDigest(row.choices_md) !== assessmentDigest(input.choices_md)
  )
    return { kind: 'unavailable' };
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, input.id))
    .limit(1);
  const evidence = lifecycle?.scoring_admission_evidence;
  if (
    lifecycle?.scoring_admission_state !== 'admitted' ||
    lifecycle.current_revision_id == null ||
    evidence?.calibration == null ||
    evidence.marking_provenance !== 'system_verified' ||
    evidence.verification.independent_verification?.passed !== true
  )
    return { kind: 'unavailable' };
  const [frozen] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
    .limit(1);
  if (
    frozen == null ||
    normalizeQuestionRowToContract(row).integrity_digest !== frozen.integrity_digest
  )
    return { kind: 'unavailable' };
  validateChoiceCalibration(revisionRowToContract(frozen), evidence.calibration);
  const refs = evidence.calibration.solves;
  const receipts = await db
    .select()
    .from(ai_task_runs)
    .where(
      inArray(
        ai_task_runs.id,
        refs.map((ref) => ref.task_run_id),
      ),
    );
  if (
    refs.some(
      (ref) =>
        !receipts.some(
          (receipt) =>
            receipt.id === ref.task_run_id &&
            receipt.status === 'success' &&
            receipt.task_kind === 'ChoiceEntrySolveTask' &&
            receipt.provider === ref.provider &&
            receipt.model === ref.model,
        ),
    )
  ) {
    return { kind: 'unavailable' };
  }
  return { kind: 'verified', task_run_ids: refs.map((ref) => ref.task_run_id) };
}

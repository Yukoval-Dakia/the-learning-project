// One blind solve proposes keys and the solution prior. Only an author key that accepts the
// blind answer settles a unit here; everything else goes to adjudication.
import { eq } from 'drizzle-orm';
import type { TaskTextResult } from '@/ai/task-result';
import { canonicalHash } from '@/core/migration/canonical';
import { rawArgumentsEvidence } from '@/core/raw-arguments-evidence';
import type { AnswerKeyT } from '@/core/schema/assessment/answer-compare';
import { compileDeclaredKey } from '@/core/schema/assessment/blank-answer-compare';
import type { BlankAnswerShapeT } from '@/core/schema/assessment/blank-answer-shape';
import { gradeBlankAuthorKeyUnit, gradeSelectUnit } from '@/core/schema/assessment/grade';
import type { ScoringUnitResultT } from '@/core/schema/assessment/judgment';
import { isPublicSharedMaterial } from '@/core/schema/assessment/materials';
import { describeSelectItem } from '@/core/schema/assessment/response';
import type { ScoringUnitCriterionT, ScoringUnitT } from '@/core/schema/assessment/scoring';
import { taskInputHash } from '@/core/task-input-hash';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { writeToolCallLog } from '@/kernel/tools/call-evidence';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import type { SubjectProfile } from '@/subjects/profile';
import {
  QuestionAdmissionPriorInput,
  QuestionAdmissionSolveInput,
  type QuestionAdmissionSolveInputT,
  type QuestionAdmissionSolveOutputT,
  type QuestionAdmissionSolveUnitOutputT,
  type QuestionAdmissionSolveUnitT,
  parseQuestionAdmissionSolveModelOutput,
  undeclaredPriorFields,
} from '../../tasks/question-admission-solve';
import { AdmissionAttemptExhausted, AdmissionParseFailure, runAdmissionAttempts } from './attempt';
import type { AdmissionUnitSpec, QuestionAdmissionDefinition } from './contract';
import {
  type KnowledgeCandidate,
  type SolutionPriorRecordT,
  buildSolutionPriorRecord,
} from './solution-prior';

export type { Provider } from '../quiz/verify-framework';

export type AdmissionImage = { data: string; mediaType: string };
export function admissionWireInput(
  payload: unknown,
  images: readonly AdmissionImage[] = [],
): unknown {
  return images.length ? { text: JSON.stringify(payload), images } : payload;
}

export const QUESTION_ADMISSION_TASK_KIND = 'QuestionAdmissionSolveTask';

/** 已 mint 的 typed 键（solve 输出 ∪ 既有判据的统一表示）。 */
export type AdmissionKey = AnswerKeyT;

export interface AdmissionSolveReceipt {
  task_run_id: string;
  provider: string;
  model: string;
  input_digest: string;
  output_digest: string;
  /** null = cost unknown（如实记录，不冒名）。 */
  cost_usd: number | null;
}

export type UnitSolveVerdict =
  | { status: 'agreed'; key: AdmissionKey }
  /** No author key: the blind key is only a proposal until adjudication decides. */
  | { status: 'unconfirmed'; key: AdmissionKey; detail: string }
  | { status: 'conflict'; detail: string }
  | { status: 'unsolvable'; detail: string }
  | { status: 'seed_mismatch'; detail: string }
  | { status: 'not_applicable'; detail: string };

export interface BlindSolveResult {
  verdicts: Map<string, UnitSolveVerdict>;
  attempt_run_ids: string[];
  output: QuestionAdmissionSolveOutputT;
  receipt: AdmissionSolveReceipt;
  /** The blind solve's own typed keys, compared with the published keys for the prior. */
  blind_keys: Map<string, AdmissionKey>;
  /** Blind wrong-answer candidates and explicitly adjudicated correct/incorrect forms. */
  probe_candidates: Map<
    string,
    {
      equivalent_forms: { item_ids?: string[]; text?: string }[];
      typical_wrong: { item_ids?: string[]; text?: string; reason_md?: string }[];
    }
  >;
  /** Null when no part carried a usable prior; the solve itself is unaffected. */
  prior: SolutionPriorRecordT | null;
}

/** 部分失败不丢已付费收据：ok:false 时 receipts 仍带上已完成的 solve。 */
export type BlindSolveOutcome =
  | { ok: true; result: BlindSolveResult }
  | { ok: false; error: string; receipts: AdmissionSolveReceipt[] };

const SUBMIT_TOOL_NAME = 'mcp__structured_output__submit';

/**
 * when a structured submit reaches the capability but fails the
 * schema/parse layer, keep the exact submit arguments (bounded) as a
 * tool_call_log row attached to that task run, and return the full-payload
 * digest so the thrown error / unresolved_reason can be matched back to it.
 * The runner records the adapter-level variant (invalid raw wire arguments)
 * itself; this covers the success-terminal-but-schema-invalid layer only.
 */
async function recordSubmitFailureEvidence(
  db: Db,
  taskRunId: string | null | undefined,
  raw: unknown,
): Promise<string> {
  const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  const evidence = rawArgumentsEvidence(serialized);
  if (taskRunId == null) return evidence.raw_args_sha256;
  try {
    await writeToolCallLog(db, {
      task_run_id: taskRunId,
      task_kind: QUESTION_ADMISSION_TASK_KIND,
      tool_name: SUBMIT_TOOL_NAME,
      input_json: { ...evidence },
      output_json: {},
      error_reason: 'structured_output_parse_failed',
      iteration: 0,
      latency_ms: 0,
      cost: 0,
    });
  } catch (error) {
    // The evidence write must never mask the original parse failure.
    console.warn('[question_admission] submit failure evidence write failed', {
      task_run_id: taskRunId,
      err: error instanceof Error ? error.message : String(error),
    });
  }
  return evidence.raw_args_sha256;
}

/** task_run 收据密封：必须存在、成功、kind 匹配、input hash 精确绑定本次请求体。 */
export async function sealTaskRun(
  db: Db,
  payload: unknown,
  result: TaskTextResult,
  output: unknown,
  taskKind = QUESTION_ADMISSION_TASK_KIND,
): Promise<AdmissionSolveReceipt> {
  if (result.task_run_id == null) {
    throw new Error('question admission solve has no durable task run receipt');
  }
  const [receipt] = await db
    .select()
    .from(ai_task_runs)
    .where(eq(ai_task_runs.id, result.task_run_id))
    .limit(1);
  if (
    receipt?.status !== 'success' ||
    receipt.task_kind !== taskKind ||
    receipt.input_hash !== taskInputHash(payload)
  ) {
    throw new Error(
      'question admission solve requires a successful central task receipt bound to its input',
    );
  }
  return {
    task_run_id: receipt.id,
    provider: receipt.provider,
    model: receipt.model,
    input_digest: canonicalHash(payload),
    output_digest: canonicalHash(output),
    cost_usd: receipt.cost_usd ?? null,
  };
}

// ---------- solve input 构造（公共材料才进题面；私有 solution/rubric 绝不发给 solver） ----------

export function solverUnits(
  definition: QuestionAdmissionDefinition,
  opts: { exposePrinted: boolean },
): QuestionAdmissionSolveUnitT[] {
  const slotById = new Map(definition.response_spec.slots.map((s) => [s.slot_id, s] as const));
  // unsupported 单元不进 solve 输入（无法升级 —— 它们的判据形态 solver 也出不了）。
  // exposePrinted=false 时绝不携带印出判分规则/rubric 文本（可能内含答案）——
  // solve lane 保持零答案面；crosscheck lane 经显式 source_answers 给文本。
  return definition.units
    .filter(
      (unit): unit is AdmissionUnitSpec & { unit_kind: 'select' | 'blank' | 'free' } =>
        unit.unit_kind !== 'unsupported',
    )
    .map((unit) => {
      const slot = unit.slot_refs[0] != null ? slotById.get(unit.slot_refs[0]) : undefined;
      const select =
        slot?.kind === 'select'
          ? {
              pick: slot.pick,
              items: slot.items.map((item) => ({
                item_id: item.item_id,
                display_md: item.label_md ?? describeSelectItem(slot, item.item_id),
              })),
            }
          : undefined;
      const answerKind: 'blank_text' | 'blank_numeric' | undefined =
        unit.seeded_criterion?.kind === 'blank_key'
          ? unit.seeded_criterion.key.kind === 'numeric'
            ? 'blank_numeric'
            : 'blank_text'
          : undefined;
      const blank =
        slot?.kind === 'blank'
          ? {
              format: slot.format,
              ...(slot.unit_hint != null ? { unit_hint: slot.unit_hint } : {}),
              ...(answerKind != null ? { answer_kind: answerKind } : {}),
              // 第 2 片：公开输入语义随 solve 载荷下发（不携带任何
              // 答案/端点/容差 —— 那些在私有 scoring key 里）。
              ...(slot.answer_shape != null ? { answer_shape: slot.answer_shape } : {}),
            }
          : undefined;
      return {
        scoring_unit_id: unit.scoring_unit_id,
        part_id: unit.part_id,
        kind: unit.unit_kind,
        printed_points: unit.points,
        ...(opts.exposePrinted && unit.printed_rule_md != null
          ? { printed_rule_md: unit.printed_rule_md }
          : {}),
        ...(select != null ? { select } : {}),
        ...(blank != null ? { blank } : {}),
        ...(opts.exposePrinted && unit.unit_kind === 'free' && unit.printed_rule_md != null
          ? { free_rubric_md: unit.printed_rule_md }
          : {}),
      };
    });
}

export function solverParts(
  definition: QuestionAdmissionDefinition,
): QuestionAdmissionSolveInputT['parts'] {
  const figures = definition.structure.materials.filter(
    (m) => isPublicSharedMaterial(m) && m.kind === 'figure',
  );
  const materialById = new Map(
    definition.structure.materials.map((m) => [m.material_id, m] as const),
  );
  return definition.structure.parts.map((part) => ({
    part_id: part.part_id,
    ...(part.question_no != null ? { question_no: part.question_no } : {}),
    prompt_md: part.prompt_md,
    materials: part.material_ids
      .map((id) => materialById.get(id))
      .filter(
        (m): m is NonNullable<typeof m> =>
          m != null && isPublicSharedMaterial(m) && (m.content_md != null || m.kind === 'figure'),
      )
      .map((m) => ({
        material_id: m.material_id,
        text_md:
          m.kind === 'figure'
            ? `Figure image ${figures.findIndex((f) => f.material_id === m.material_id) + 1}: ${m.alt_text ?? m.caption ?? ''}`
            : (m.content_md ?? ''),
      })),
  }));
}

// ---------- 输出校验 + typed key 一致性 ----------

function validSolveUnitOutput(
  unit: AdmissionUnitSpec,
  output: QuestionAdmissionSolveUnitOutputT,
): { ok: true } | { ok: false; detail: string } {
  if (output.status === 'unsolvable') return { ok: true };
  const answer = output.answer;
  if (answer == null) return { ok: false, detail: 'solved unit without typed answer' };
  if (unit.unit_kind === 'select' && answer.kind === 'select') return { ok: true };
  if (
    unit.unit_kind === 'blank' &&
    (answer.kind === 'blank_text' || answer.kind === 'blank_numeric')
  ) {
    return { ok: true };
  }
  if (unit.unit_kind === 'free' && answer.kind === 'free') return { ok: true };
  return {
    ok: false,
    detail: `answer kind '${answer.kind}' does not match unit kind '${unit.unit_kind}'`,
  };
}

export function keyFromAnswer(
  answer: NonNullable<QuestionAdmissionSolveUnitOutputT['answer']>,
): AdmissionKey | null {
  switch (answer.kind) {
    case 'select':
      return { kind: 'select', accepted_item_ids: answer.item_ids };
    case 'blank_text':
      return { kind: 'blank_text', accepted: answer.accepted };
    case 'blank_numeric':
      return {
        kind: 'blank_numeric',
        expected: answer.expected,
        tolerance: answer.tolerance,
        ...(answer.expected_unit != null ? { expected_unit: answer.expected_unit } : {}),
      };
    case 'free':
      return null;
  }
}

/** The author's stored key. Model output is compared against it and never copied over it. */
function authorAdmissionKey(seed: ScoringUnitCriterionT | null): AdmissionKey | null {
  if (seed?.kind === 'select_key') {
    return { kind: 'select', accepted_item_ids: [...seed.accepted_item_ids] };
  }
  if (seed?.kind === 'blank_key' && seed.key.kind === 'text') {
    return { kind: 'blank_text', accepted: [...seed.key.accepted] };
  }
  if (seed?.kind === 'blank_key' && seed.key.kind === 'numeric') {
    return {
      kind: 'blank_numeric',
      expected: seed.key.expected,
      tolerance: seed.key.tolerance,
      ...(seed.key.expected_unit != null ? { expected_unit: seed.key.expected_unit } : {}),
    };
  }
  return null;
}

function gradingUnit(unit: AdmissionUnitSpec): ScoringUnitT | null {
  const criterion = unit.seeded_criterion;
  if (criterion?.kind !== 'select_key' && criterion?.kind !== 'blank_key') return null;
  const points = unit.points ?? 0;
  const rule =
    unit.seeded_rule ??
    (criterion.kind === 'blank_key'
      ? {
          version: 1 as const,
          cases: [{ when: { correct: { eq: 1 } }, award: { points } }],
          otherwise: { points: 0 },
        }
      : {
          version: 1 as const,
          cases: [
            {
              when: { all: [{ wrong: { eq: 0 } }, { miss: { eq: 0 } }] },
              award: { points },
            },
          ],
          otherwise: { points: 0 },
        });
  return {
    scoring_unit_id: unit.scoring_unit_id,
    slot_refs: unit.slot_refs,
    material_refs: unit.material_refs,
    evidence_slot_refs: unit.evidence_slot_refs,
    requires_group_evidence: unit.requires_group_evidence,
    criterion,
    points: unit.points,
    rule,
  };
}

function modelFinalAnswerText(key: AdmissionKey): string | null {
  if (key.kind === 'blank_text') return key.accepted[0] ?? null;
  if (key.kind !== 'blank_numeric') return null;
  return key.expected_unit != null ? `${key.expected} ${key.expected_unit}` : String(key.expected);
}

function authorKeyAcceptsGrade(result: ScoringUnitResultT, points: number | null): boolean {
  if (result.status !== 'scored' || result.comparison == null) return false;
  const { comparison } = result;
  const keyHit =
    comparison.correct === 1 ||
    (comparison.set != null &&
      comparison.set.expected > 0 &&
      comparison.set.wrong === 0 &&
      comparison.set.miss === 0 &&
      comparison.set.hit === comparison.set.expected);
  if (!keyHit) return false;
  if (points == null) return true;
  return result.points_awarded === points;
}

/**
 * 作者键是否接受模型的最终答案：走这道题自己的判分器，不另定相等。
 * Every solver alias must pass the frozen grader, including shape-free text.
 * The minted key remains the author's full key after independent agreement.
 */
async function authorKeyAccepts(
  unit: AdmissionUnitSpec,
  key: AdmissionKey,
  shape?: BlankAnswerShapeT,
): Promise<boolean> {
  const scoring = gradingUnit(unit);
  const slotId = unit.slot_refs[0];
  if (scoring == null || slotId == null) return false;
  if (key.kind === 'select' && scoring.criterion.kind === 'select_key') {
    return authorKeyAcceptsGrade(
      gradeSelectUnit(scoring, {
        slot_id: slotId,
        kind: 'select',
        state: 'answered',
        item_ids: key.accepted_item_ids,
      }),
      unit.points,
    );
  }
  if (scoring.criterion.kind !== 'blank_key') return false;
  if (key.kind === 'blank_text') {
    for (const alias of key.accepted) {
      const graded = await gradeBlankAuthorKeyUnit(
        scoring,
        { slot_id: slotId, kind: 'blank', state: 'answered', text: alias },
        shape,
      );
      if (!authorKeyAcceptsGrade(graded, unit.points)) return false;
    }
    return true;
  }
  const text = modelFinalAnswerText(key);
  if (text == null) return false;
  return authorKeyAcceptsGrade(
    await gradeBlankAuthorKeyUnit(
      scoring,
      { slot_id: slotId, kind: 'blank', state: 'answered', text },
      shape,
    ),
    unit.points,
  );
}

async function validateSolvePass(
  db: Db,
  result: TaskTextResult,
  payload: QuestionAdmissionSolveInputT,
  repairBudget: { remaining: number },
  images?: readonly AdmissionImage[],
): Promise<{ output: QuestionAdmissionSolveOutputT; receipt: AdmissionSolveReceipt }> {
  const wire = admissionWireInput(payload, images);
  const raw = result.structured_output != null ? result.structured_output : result.text;
  let output: QuestionAdmissionSolveOutputT;
  try {
    if (result.structured_output == null)
      throw new Error('missing structured solve output; no text fallback');
    output = parseQuestionAdmissionSolveModelOutput(raw, payload.units, repairBudget);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const taskRunId = result.task_run_id;
    const rawArgsDigest = await recordSubmitFailureEvidence(db, taskRunId, raw);
    const marked = `${
      taskRunId != null && !detail.includes(`task_run_id=${taskRunId}`)
        ? `${detail};task_run_id=${taskRunId}`
        : detail
    };raw_args_sha256=${rawArgsDigest}`;
    throw new AdmissionParseFailure(marked);
  }
  return { output, receipt: await sealTaskRun(db, wire, result, output) };
}

/** The blind solve's per-unit priors as the record shape: first prior per part wins. */
function blindPrior(
  output: QuestionAdmissionSolveOutputT,
  units: readonly QuestionAdmissionSolveUnitT[],
  partIds: readonly string[],
  taskRunId: string,
): SolutionPriorRecordT | null {
  const partOf = new Map(units.map((unit) => [unit.scoring_unit_id, unit.part_id] as const));
  const byPart = new Map<string, unknown>();
  for (const unit of output.units) {
    const partId = partOf.get(unit.scoring_unit_id);
    if (partId == null || unit.prior == null || byPart.has(partId)) continue;
    const stripped = undeclaredPriorFields(unit.prior);
    if (stripped.length > 0)
      console.warn('[question_admission] solution prior undeclared fields stripped', {
        task_run_id: taskRunId,
        scoring_unit_id: unit.scoring_unit_id,
        fields: stripped,
      });
    byPart.set(partId, { part_id: partId, ...unit.prior });
  }
  return buildSolutionPriorRecord({
    raw: [...byPart.values()],
    partIds,
    candidates: [],
    taskRunId,
  });
}

/** Known exhausted attempts return repair; unknown paid outcomes escape to the durable batch fence. */
export async function runBlindSolve(
  db: Db,
  definition: QuestionAdmissionDefinition,
  deps: {
    runTask: BoundRunTaskTextFn;
    subjectProfile?: SubjectProfile;
    images?: readonly AdmissionImage[];
  },
): Promise<BlindSolveOutcome> {
  const parts = solverParts(definition);
  // The solve lane strips every printed scoring/answer text (rule_reference.statement_md
  // goes only to adjudication); a solve that saw the answer would prove nothing.
  const units = solverUnits(definition, { exposePrinted: false });
  const payload = QuestionAdmissionSolveInput.parse({ mode: 'solve', parts, units });

  let solved: { output: QuestionAdmissionSolveOutputT; receipt: AdmissionSolveReceipt };
  let attemptIds: string[];
  try {
    const pass = await runAdmissionAttempts(
      db,
      () =>
        deps.runTask(QUESTION_ADMISSION_TASK_KIND, admissionWireInput(payload, deps.images), {
          judgeRetryPolicy: 'none',
          budgetOverride: { maxIterations: 1 },
          ...(deps.subjectProfile ? { subjectProfile: deps.subjectProfile } : {}),
        }),
      async (result) => validateSolvePass(db, result, payload, { remaining: 1 }, deps.images),
    );
    solved = pass.value;
    attemptIds = [...pass.taskRunIds];
  } catch (error) {
    if (!(error instanceof AdmissionAttemptExhausted)) throw error;
    return {
      ok: false,
      error: `blind solve failed: ${error instanceof Error ? error.message : String(error)}`,
      receipts: [],
    };
  }

  const byUnit = new Map(solved.output.units.map((u) => [u.scoring_unit_id, u] as const));
  const verdicts = new Map<string, UnitSolveVerdict>();
  const blindKeys = new Map<string, AdmissionKey>();
  const probeCandidates: BlindSolveResult['probe_candidates'] = new Map();

  for (const unit of definition.units) {
    if (unit.unit_kind === 'unsupported' || unit.unit_kind === 'free') {
      verdicts.set(unit.scoring_unit_id, {
        status: 'not_applicable',
        detail:
          unit.unit_kind === 'free'
            ? 'free units require semantic adjudication and a system-admitted model grader'
            : `slot kinds cannot be upgraded to a deterministic unit`,
      });
      continue;
    }
    const out = byUnit.get(unit.scoring_unit_id);
    if (out == null) {
      verdicts.set(unit.scoring_unit_id, {
        status: 'conflict',
        detail: 'solver output missing unit',
      });
      continue;
    }
    const valid = validSolveUnitOutput(unit, out);
    if (!valid.ok) {
      verdicts.set(unit.scoring_unit_id, {
        status: 'conflict',
        detail: `invalid solver output: ${valid.detail}`,
      });
      continue;
    }
    if (out.status === 'unsolvable') {
      verdicts.set(unit.scoring_unit_id, {
        status: 'unsolvable',
        detail: out.reason_md || 'solver reported unsolvable',
      });
      continue;
    }
    const key = out.answer != null ? keyFromAnswer(out.answer) : null;
    if (key == null) {
      verdicts.set(unit.scoring_unit_id, { status: 'conflict', detail: 'no typed key emitted' });
      continue;
    }
    // universe 守卫：select 键不得引用未声明 item。
    if (key.kind === 'select') {
      const slot = definition.response_spec.slots.find((s) => s.slot_id === unit.slot_refs[0]);
      const universe = new Set(slot?.kind === 'select' ? slot.items.map((i) => i.item_id) : []);
      if (key.accepted_item_ids.some((id) => !universe.has(id))) {
        verdicts.set(unit.scoring_unit_id, {
          status: 'conflict',
          detail: 'solver emitted an item id outside the declared universe',
        });
        continue;
      }
    }
    blindKeys.set(unit.scoring_unit_id, key);
    const authorKey = authorAdmissionKey(unit.seeded_criterion);
    // 第 2 片：该槽冻结的 answer_shape（同一比较核心；无声明 → 旧路径逐字不变）。
    const shapeSlot = definition.response_spec.slots.find((s) => s.slot_id === unit.slot_refs[0]);
    const declaredShape =
      shapeSlot != null && shapeSlot.kind === 'blank' && shapeSlot.answer_shape != null
        ? shapeSlot.answer_shape
        : null;
    if (unit.seeded_criterion != null) {
      // 作者键自身别名先过同一编译器：任一别名不完整/互不一致/与声明冲突
      // （单位缺项等）→ 契约级冲突，不铸键、不进入后续核验。
      if (declaredShape != null && unit.seeded_criterion.kind === 'blank_key') {
        const authorCompile = compileDeclaredKey(declaredShape, unit.seeded_criterion.key);
        if (!authorCompile.ok) {
          verdicts.set(unit.scoring_unit_id, {
            status: 'conflict',
            detail: `author key invalid under declared answer_shape: ${authorCompile.reason}`,
          });
          continue;
        }
      }
      if (authorKey == null || !(await authorKeyAccepts(unit, key, declaredShape ?? undefined))) {
        verdicts.set(unit.scoring_unit_id, {
          status: 'seed_mismatch',
          detail: 'the author key does not accept the solver answer',
        });
        continue;
      }
      verdicts.set(unit.scoring_unit_id, { status: 'agreed', key: authorKey });
    } else {
      verdicts.set(unit.scoring_unit_id, {
        status: 'unconfirmed',
        key,
        detail: 'no author key; the blind key needs adjudication',
      });
    }
    probeCandidates.set(unit.scoring_unit_id, {
      equivalent_forms: [],
      typical_wrong: (out.typical_wrong ?? []).map((w) => ({
        ...(w.item_ids != null ? { item_ids: w.item_ids } : {}),
        ...(w.text != null ? { text: w.text } : {}),
        ...(w.reason_md != null ? { reason_md: w.reason_md } : {}),
      })),
    });
  }
  return {
    ok: true,
    result: {
      verdicts,
      attempt_run_ids: attemptIds,
      output: solved.output,
      receipt: solved.receipt,
      blind_keys: blindKeys,
      probe_candidates: probeCandidates,
      prior: blindPrior(
        solved.output,
        units,
        parts.map((part) => part.part_id),
        solved.receipt.task_run_id,
      ),
    },
  };
}

function describeKey(
  key: AdmissionKey,
  definition: QuestionAdmissionDefinition,
  unitId: string,
): string {
  const unit = definition.units.find((u) => u.scoring_unit_id === unitId);
  const slot =
    unit?.slot_refs[0] != null
      ? definition.response_spec.slots.find((s) => s.slot_id === unit.slot_refs[0])
      : undefined;
  switch (key.kind) {
    case 'select':
      return `选择：${key.accepted_item_ids
        .map((id) => (slot?.kind === 'select' ? describeSelectItem(slot, id) : id))
        .join('；')}`;
    case 'blank_text':
      return `填空：${key.accepted.join(' 或 ')}`;
    case 'blank_numeric':
      return `数值：${key.expected}${key.expected_unit != null ? ` ${key.expected_unit}` : ''}（容差 ${
        key.tolerance.kind === 'absolute'
          ? `±${key.tolerance.value}`
          : `±${key.tolerance.ratio * 100}%`
      }）`;
  }
}

/** Frozen revision keys for a metadata-only prior backfill; never admits content. */
export function settledKeysFromDefinition(
  definition: QuestionAdmissionDefinition,
): Map<string, AdmissionKey> {
  const keys = new Map<string, AdmissionKey>();
  for (const unit of definition.units) {
    const key = authorAdmissionKey(unit.seeded_criterion);
    if (key != null) keys.set(unit.scoring_unit_id, key);
  }
  return keys;
}

export interface SolutionPriorPassResult {
  record: SolutionPriorRecordT | null;
  receipt: AdmissionSolveReceipt | null;
  /** Kept in the admission evidence, so a question without a prior is explained, not silent. */
  outcome: {
    status: 'produced' | 'empty' | 'failed' | 'skipped';
    task_run_id: string | null;
    reason?: string;
  };
}

/**
 * Describe how the question is solved, once its keys are settled. Metadata only: every
 * failure resolves to no prior, so this can neither change a verdict nor hold a batch.
 */
export async function runSolutionPriorPass(
  db: Db,
  definition: QuestionAdmissionDefinition,
  keys: Map<string, AdmissionKey>,
  deps: {
    runTask: BoundRunTaskTextFn;
    subjectProfile?: SubjectProfile;
    knowledgeCandidates?: readonly KnowledgeCandidate[];
    freeRubrics?: ReadonlyMap<string, string>;
    images?: readonly AdmissionImage[];
  },
): Promise<SolutionPriorPassResult> {
  const parts = solverParts(definition);
  let taskRunId: string | null = null;
  try {
    const candidates = [...(deps.knowledgeCandidates ?? [])];
    const payload = QuestionAdmissionPriorInput.parse({
      mode: 'prior',
      parts,
      units: solverUnits(definition, { exposePrinted: false }),
      answers: [
        ...[...keys.entries()].map(([unitId, key]) => ({
          scoring_unit_id: unitId,
          answer_summary_md: describeKey(key, definition, unitId),
        })),
        ...[...(deps.freeRubrics ?? [])].map(([unitId, rubric]) => ({
          scoring_unit_id: unitId,
          answer_summary_md: rubric,
        })),
      ],
      knowledge_candidates: candidates,
    });
    const wire = admissionWireInput(payload, deps.images);
    const result = await deps.runTask(QUESTION_ADMISSION_TASK_KIND, wire, {
      judgeRetryPolicy: 'none',
      budgetOverride: { maxIterations: 1 },
      ...(deps.subjectProfile != null ? { subjectProfile: deps.subjectProfile } : {}),
    });
    taskRunId = result.task_run_id ?? null;
    const receipt = await sealTaskRun(db, wire, result, result.structured_output);
    const raw = (result.structured_output as { prior?: unknown } | null | undefined)?.prior;
    const record = buildSolutionPriorRecord({
      raw,
      partIds: parts.map((part) => part.part_id),
      candidates,
      taskRunId: receipt.task_run_id,
    });
    return {
      record,
      receipt,
      outcome: {
        status: record != null ? 'produced' : 'empty',
        task_run_id: receipt.task_run_id,
        ...(record == null ? { reason: 'no usable part in the model output' } : {}),
      },
    };
  } catch (error) {
    const failedRunId =
      error != null &&
      typeof error === 'object' &&
      'taskRunId' in error &&
      typeof error.taskRunId === 'string'
        ? error.taskRunId
        : taskRunId;
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    console.warn('[question_admission] solution prior pass failed', {
      group_id: definition.group_id,
      task_run_id: failedRunId,
      err: reason,
    });
    return {
      record: null,
      receipt: null,
      outcome: { status: 'failed', task_run_id: failedRunId, reason },
    };
  }
}

// Two isolated blind solves produce candidate keys; disagreements go to adjudication.
import { eq } from 'drizzle-orm';
import type { TaskTextResult } from '@/ai/task-result';
import { canonicalHash } from '@/core/migration/canonical';
import { rawArgumentsEvidence } from '@/core/raw-arguments-evidence';
import {
  type DeclaredPrivateKey,
  compileDeclaredKey,
  compiledCanonicalOf,
  declaredRationalValueOf,
} from '@/core/schema/assessment/blank-answer-compare';
import type { BlankAnswerShapeT } from '@/core/schema/assessment/blank-answer-shape';
import {
  gradeBlankExactUnit,
  gradeSelectUnit,
  normalizeBlankText,
  parseBlankNumericText,
} from '@/core/schema/assessment/grade';
import type { ScoringUnitResultT } from '@/core/schema/assessment/judgment';
import { isPublicSharedMaterial } from '@/core/schema/assessment/materials';
import { describeSelectItem } from '@/core/schema/assessment/response';
import type {
  BlankNormalizationT,
  ScoringUnitCriterionT,
  ScoringUnitT,
} from '@/core/schema/assessment/scoring';
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
} from '../../tasks/question-admission-solve';
// Provider 经 verify-framework 取；TaskTextResult 直接取共享结果契约。
// 输入 hash 直接使用 core 的完整规范化算法。
import type { Provider } from '../quiz/verify-framework';
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
export type AdmissionKey =
  | { kind: 'select'; accepted_item_ids: string[] }
  | { kind: 'blank_text'; accepted: string[] }
  | {
      kind: 'blank_numeric';
      expected: number;
      tolerance: { kind: 'absolute'; value: number } | { kind: 'relative'; ratio: number };
      expected_unit?: string;
    };

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
  | { status: 'conflict'; detail: string }
  | { status: 'unsolvable'; detail: string }
  | { status: 'seed_mismatch'; detail: string }
  | { status: 'not_applicable'; detail: string };

export interface DualSolveResult {
  verdicts: Map<string, UnitSolveVerdict>;
  attempt_run_ids: string[];
  outputs: [QuestionAdmissionSolveOutputT, QuestionAdmissionSolveOutputT];
  solve_a: AdmissionSolveReceipt;
  solve_b: AdmissionSolveReceipt;
  /** Blind wrong-answer candidates and explicitly adjudicated correct/incorrect forms. */
  probe_candidates: Map<
    string,
    {
      equivalent_forms: { item_ids?: string[]; text?: string }[];
      typical_wrong: { item_ids?: string[]; text?: string; reason_md?: string }[];
    }
  >;
}

/** 部分失败不丢已付费收据：ok:false 时 receipts 仍带上已完成的 solve。 */
export type DualSolveOutcome =
  | { ok: true; result: DualSolveResult }
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
  variant: number,
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
              items: (variant === 1 ? [...slot.items].reverse() : slot.items).map((item) => ({
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

/** Conflict details stay bounded — they land in withheld evidence and reasons. */
const DETAIL_VALUE_MAX = 160;
function boundDetail(value: string, max = DETAIL_VALUE_MAX): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

/** Compact value-level rendering of a key for conflict details. */
function keyBrief(key: AdmissionKey): string {
  switch (key.kind) {
    case 'select':
      return boundDetail(`select[${key.accepted_item_ids.join(',')}]`);
    case 'blank_text':
      return boundDetail(`blank_text[${key.accepted.join('|')}]`);
    case 'blank_numeric':
      return `blank_numeric{expected=${key.expected},tolerance=${JSON.stringify(
        key.tolerance,
      )},unit=${key.expected_unit ?? '∅'}}`;
  }
}

type NumericTolerance = { kind: 'absolute'; value: number } | { kind: 'relative'; ratio: number };

const tolOf = (t: { value?: number; ratio?: number }) => t.value ?? t.ratio ?? 0;

function withinToleranceOf(x: number, expected: number, tolerance: NumericTolerance): boolean {
  return tolerance.kind === 'absolute'
    ? Math.abs(x - expected) <= tolerance.value
    : expected === 0
      ? x === expected
      : Math.abs(x - expected) / Math.abs(expected) <= tolerance.ratio;
}

/** AdmissionKey → 比较核心的私有键读面（select 无对应 —— 声明只在 blank 槽）。 */
function privateKeyOf(key: AdmissionKey): DeclaredPrivateKey | null {
  switch (key.kind) {
    case 'select':
      return null;
    case 'blank_text':
      return { kind: 'text', accepted: key.accepted };
    case 'blank_numeric':
      return {
        kind: 'numeric',
        expected: key.expected,
        tolerance: key.tolerance,
        ...(key.expected_unit != null ? { expected_unit: key.expected_unit } : {}),
      };
  }
}

/**
 * 已声明槽的 A/B 键一致性（第 2 片）：两侧【全部】别名经同一
 * compileDeclaredKey 编译，每个别名必须完整解析且为同一数学对象（别名数
 * 可不同）；铸出的键携带全部已验证别名 —— 实际 grade 逐一接受。
 * 返回 null = 交由既有分支（numeric/numeric 容差铸键，单位相容已验）。
 */
function declaredKeysAgree(
  a: AdmissionKey,
  b: AdmissionKey,
  shape: BlankAnswerShapeT,
): { agree: boolean; detail?: string; key?: AdmissionKey } | null {
  if (a.kind === 'select' || b.kind === 'select') {
    return { agree: false, detail: 'select key cannot satisfy a declared answer_shape' };
  }
  if (a.kind === 'blank_text' && b.kind === 'blank_text') {
    const privateKeyA = privateKeyOf(a);
    const privateKeyB = privateKeyOf(b);
    if (privateKeyA == null || privateKeyB == null) {
      return { agree: false, detail: 'blank_text keys must carry an accepted alias list' };
    }
    const ca = compileDeclaredKey(shape, privateKeyA);
    const cb = compileDeclaredKey(shape, privateKeyB);
    if (!ca.ok) {
      return {
        agree: false,
        detail: `solver A aliases invalid under declared shape: ${ca.reason}`,
      };
    }
    if (!cb.ok) {
      return {
        agree: false,
        detail: `solver B aliases invalid under declared shape: ${cb.reason}`,
      };
    }
    const canonicalA = compiledCanonicalOf(ca.compiled);
    const canonicalB = compiledCanonicalOf(cb.compiled);
    if (canonicalA == null || canonicalB == null || canonicalA !== canonicalB) {
      return {
        agree: false,
        detail: `independent solves disagree as declared objects: ${canonicalA} vs ${canonicalB}`,
      };
    }
    const accepted = [...a.accepted, ...b.accepted.filter((t) => !a.accepted.includes(t))];
    return {
      agree: true,
      key: { kind: 'blank_text', accepted },
      detail: `agreed as declared object ${canonicalA} (${accepted.length} validated aliases)`,
    };
  }
  if (a.kind === 'blank_numeric' && b.kind === 'blank_numeric') {
    if (shape.value.kind !== 'number') {
      return {
        agree: false,
        detail: `numeric keys cannot express declared value kind '${shape.value.kind}'`,
      };
    }
    if (shape.value.unit != null) {
      const unit = shape.value.unit.unit.normalize('NFKC');
      const norm = (u?: string): string => (u ?? '').normalize('NFKC');
      if (norm(a.expected_unit) !== unit || norm(b.expected_unit) !== unit) {
        return {
          agree: false,
          detail: `declared unit '${unit}' vs keys ${a.expected_unit ?? '∅'}/${b.expected_unit ?? '∅'}`,
        };
      }
    }
    return null; // 单位/形态相容 → 既有容差铸键分支（更严容差侧）。
  }
  // 跨 kind（numeric × text）：仅无声明单位的 number 形状；文本侧全部别名
  // 必须编译为同一精确有理值且落在冻结容差内 —— 铸 numeric 键（判分读法
  // 逐一接受这些文本形式）。
  const numeric = a.kind === 'blank_numeric' ? a : b.kind === 'blank_numeric' ? b : null;
  const text = a.kind === 'blank_text' ? a : b.kind === 'blank_text' ? b : null;
  if (
    numeric != null &&
    text != null &&
    shape.value.kind === 'number' &&
    shape.value.unit == null &&
    numeric.expected_unit == null
  ) {
    const privateKey = privateKeyOf(text);
    if (privateKey == null) {
      return { agree: false, detail: 'blank_text key must carry an accepted alias list' };
    }
    const ct = compileDeclaredKey(shape, privateKey);
    if (!ct.ok) {
      return {
        agree: false,
        detail: `text aliases invalid under declared number shape: ${ct.reason}`,
      };
    }
    const value = declaredRationalValueOf(ct.compiled);
    if (value != null && withinToleranceOf(value, numeric.expected, numeric.tolerance)) {
      return {
        agree: true,
        key: numeric,
        detail: `text forms all read as the declared numeric key: ${boundDetail(text.accepted.join('|'))} -> ${keyBrief(numeric)}`,
      };
    }
    return {
      agree: false,
      detail: `declared text aliases (${boundDetail(text.accepted.join('|'))}) disagree with ${keyBrief(numeric)}`,
    };
  }
  return {
    agree: false,
    detail: `key kinds ${a.kind}/${b.kind} cannot agree under declared value kind '${shape.value.kind}'`,
  };
}

export function keysAgree(
  a: AdmissionKey,
  b: AdmissionKey,
  normalization: BlankNormalizationT | null,
  shape?: BlankAnswerShapeT | null,
): { agree: boolean; detail?: string; key?: AdmissionKey } {
  if (shape != null) {
    const declared = declaredKeysAgree(a, b, shape);
    if (declared != null) return declared;
    // numeric/numeric 且单位/形态已验相容 → 落到既有容差铸键分支。
  }
  if (a.kind !== b.kind) {
    // blank_text vs blank_numeric may still describe ONE key: every
    // accepted text form must read as a plain number under the SAME
    // deterministic parse the minted numeric key later applies in grading
    // (parseBlankNumericText; NFKC + trim + plain number, no units/separators),
    // and each value must land inside the numeric tolerance. A numeric key
    // carrying expected_unit can never agree — plain-number forms have no unit.
    const numeric = a.kind === 'blank_numeric' ? a : b.kind === 'blank_numeric' ? b : null;
    const text = a.kind === 'blank_text' ? a : b.kind === 'blank_text' ? b : null;
    if (numeric != null && text != null && numeric.expected_unit == null) {
      const parsed = text.accepted.map((form) => ({ form, value: parseBlankNumericText(form) }));
      if (
        parsed.length > 0 &&
        parsed.every(
          (entry) =>
            entry.value != null &&
            withinToleranceOf(entry.value, numeric.expected, numeric.tolerance),
        )
      ) {
        // Mint the NUMERIC key — its grading read accepts exactly the forms
        // that just parsed, so admission and grading stay consistent.
        return {
          agree: true,
          key: numeric,
          detail: `text forms all read as the numeric key: ${boundDetail(
            text.accepted.join('|'),
          )} -> ${keyBrief(numeric)}`,
        };
      }
    }
    return {
      agree: false,
      detail: `key kind ${a.kind} vs ${b.kind}: ${keyBrief(a)} vs ${keyBrief(b)}`,
    };
  }
  if (a.kind === 'select' && b.kind === 'select') {
    const sa = [...a.accepted_item_ids].sort();
    const sb = [...b.accepted_item_ids].sort();
    return sa.length === sb.length && sa.every((id, i) => id === sb[i])
      ? { agree: true, key: a }
      : {
          agree: false,
          detail: `select key ${boundDetail(sa.join(','))} vs ${boundDetail(sb.join(','))}`,
        };
  }
  if (a.kind === 'blank_text' && b.kind === 'blank_text') {
    const norm = normalization ?? {
      version: 'n/a',
      nfkc: false,
      trim_outer: true,
      casefold: false,
      collapse_whitespace: false,
      ignore_punctuation: false,
      character_variants: [],
    };
    const na = [...new Set(a.accepted.map((t) => normalizeBlankText(t, norm)))].sort();
    const nb = [...new Set(b.accepted.map((t) => normalizeBlankText(t, norm)))].sort();
    // Partial overlap cannot prove that omitted aliases are wrong.
    const allA = na.every((t) => nb.includes(t));
    const allB = nb.every((t) => na.includes(t));
    if (allA && allB) return { agree: true, key: a };
    return {
      agree: false,
      detail: `blank_text ${boundDetail(na.join('|'))} vs ${boundDetail(nb.join('|'))}`,
    };
  }
  if (a.kind === 'blank_numeric' && b.kind === 'blank_numeric') {
    if ((a.expected_unit ?? null) !== (b.expected_unit ?? null)) {
      return {
        agree: false,
        detail: `expected_unit ${a.expected_unit ?? '∅'} vs ${b.expected_unit ?? '∅'}: ${keyBrief(a)} vs ${keyBrief(b)}`,
      };
    }
    // 容差同型才可互证：absolute/relative 语义不同型 ⇒ 不视为等价，不合并铸键。
    if (a.tolerance.kind !== b.tolerance.kind) {
      return {
        agree: false,
        detail: `tolerance kind ${a.tolerance.kind} vs ${b.tolerance.kind}: ${keyBrief(a)} vs ${keyBrief(b)}`,
      };
    }
    const tolA = tolOf(a.tolerance);
    const tolB = tolOf(b.tolerance);
    const ok =
      withinToleranceOf(a.expected, b.expected, b.tolerance) &&
      withinToleranceOf(b.expected, a.expected, a.tolerance);
    if (!ok) {
      return { agree: false, detail: `numeric ${a.expected} vs ${b.expected}` };
    }
    // 一致且容差可比 ⇒ 铸更严的一侧（绝不取更宽）。
    const tighter = tolA <= tolB ? a.tolerance : b.tolerance;
    const looser = tolA <= tolB ? b.tolerance : a.tolerance;
    return {
      agree: true,
      key: { ...a, tolerance: tighter },
      detail:
        tolA === tolB
          ? undefined
          : `minted stricter tolerance (kept ${JSON.stringify(tighter)} over ${JSON.stringify(looser)})`,
    };
  }
  return {
    agree: false,
    detail: `uncomparable key kinds: ${keyBrief(a)} vs ${keyBrief(b)}`,
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
      const graded = await gradeBlankExactUnit(
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
    await gradeBlankExactUnit(
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

/** Known exhausted attempts return repair; unknown paid outcomes escape to the durable batch fence. */
export async function runDualSolve(
  db: Db,
  definition: QuestionAdmissionDefinition,
  deps: {
    runTask: BoundRunTaskTextFn;
    subjectProfile?: SubjectProfile;
    /** OPEN owner decision：异源与否由配置决定（默认同一配置模型、独立上下文）。 */
    solver2?: { provider?: Provider; model?: string } | null;
    images?: readonly AdmissionImage[];
  },
): Promise<DualSolveOutcome> {
  const parts = solverParts(definition);
  // solve lane 剥离一切印出判分/答案文本（rule_reference.statement_md 只进
  // crosscheck）—— 否则对全 rule_reference 判据的存量题，两次"盲"解都在
  // 看答案，agreement 证明不了任何东西。
  const unitsA = solverUnits(definition, 0, { exposePrinted: false });
  const payloadA = QuestionAdmissionSolveInput.parse({ mode: 'solve', parts, units: unitsA });
  const payloadB = QuestionAdmissionSolveInput.parse({
    mode: 'solve',
    parts,
    units: solverUnits(definition, 1, { exposePrinted: false }),
  });

  const repairBudget = { remaining: 1 };
  const attemptIds: string[] = [];
  const receipts: AdmissionSolveReceipt[] = [];
  let first: { output: QuestionAdmissionSolveOutputT; receipt: AdmissionSolveReceipt };
  try {
    const pass = await runAdmissionAttempts(
      db,
      () =>
        deps.runTask(QUESTION_ADMISSION_TASK_KIND, admissionWireInput(payloadA, deps.images), {
          judgeRetryPolicy: 'none',
          budgetOverride: { maxIterations: 1 },
          ...(deps.subjectProfile ? { subjectProfile: deps.subjectProfile } : {}),
        }),
      async (result) => validateSolvePass(db, result, payloadA, repairBudget, deps.images),
    );
    first = pass.value;
    attemptIds.push(...pass.taskRunIds);
  } catch (error) {
    if (!(error instanceof AdmissionAttemptExhausted)) throw error;
    return {
      ok: false,
      error: `solve_a failed: ${error instanceof Error ? error.message : String(error)}`,
      receipts,
    };
  }
  receipts.push(first.receipt);
  let second: { output: QuestionAdmissionSolveOutputT; receipt: AdmissionSolveReceipt };
  try {
    const pass = await runAdmissionAttempts(
      db,
      () =>
        deps.runTask(QUESTION_ADMISSION_TASK_KIND, admissionWireInput(payloadB, deps.images), {
          judgeRetryPolicy: 'none',
          budgetOverride: { maxIterations: 1 },
          ...(deps.subjectProfile ? { subjectProfile: deps.subjectProfile } : {}),
          ...(deps.solver2 ? { override: deps.solver2 } : {}),
        }),
      async (result) => validateSolvePass(db, result, payloadB, repairBudget, deps.images),
    );
    second = pass.value;
    attemptIds.push(...pass.taskRunIds);
  } catch (error) {
    if (!(error instanceof AdmissionAttemptExhausted)) throw error;
    return {
      ok: false,
      error: `solve_b failed: ${error instanceof Error ? error.message : String(error)}`,
      receipts,
    };
  }
  receipts.push(second.receipt);
  if (first.receipt.task_run_id === second.receipt.task_run_id) {
    return {
      ok: false,
      error: 'question admission solve re-used the same task run for both passes',
      receipts,
    };
  }

  const byUnitA = new Map(first.output.units.map((u) => [u.scoring_unit_id, u] as const));
  const byUnitB = new Map(second.output.units.map((u) => [u.scoring_unit_id, u] as const));
  const verdicts = new Map<string, UnitSolveVerdict>();
  const probeCandidates: DualSolveResult['probe_candidates'] = new Map();

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
    const outA = byUnitA.get(unit.scoring_unit_id);
    const outB = byUnitB.get(unit.scoring_unit_id);
    if (outA == null || outB == null) {
      verdicts.set(unit.scoring_unit_id, {
        status: 'conflict',
        detail: `solver output missing unit (a=${outA != null}, b=${outB != null})`,
      });
      continue;
    }
    const validA = validSolveUnitOutput(unit, outA);
    const validB = validSolveUnitOutput(unit, outB);
    if (!validA.ok || !validB.ok) {
      verdicts.set(unit.scoring_unit_id, {
        status: 'conflict',
        detail:
          `invalid solver output: ${!validA.ok ? validA.detail : ''} ${!validB.ok ? validB.detail : ''}`.trim(),
      });
      continue;
    }
    if (outA.status === 'unsolvable' || outB.status === 'unsolvable') {
      verdicts.set(unit.scoring_unit_id, {
        status: 'unsolvable',
        detail:
          [outA.reason_md, outB.reason_md].filter(Boolean).join(' / ') ||
          'solver reported unsolvable',
      });
      continue;
    }
    const keyA = outA.answer != null ? keyFromAnswer(outA.answer) : null;
    const keyB = outB.answer != null ? keyFromAnswer(outB.answer) : null;
    if (keyA == null || keyB == null) {
      verdicts.set(unit.scoring_unit_id, { status: 'conflict', detail: 'no typed key emitted' });
      continue;
    }
    // universe 守卫：select 键不得引用未声明 item。
    if (keyA.kind === 'select' || keyB.kind === 'select') {
      const slot = definition.response_spec.slots.find((s) => s.slot_id === unit.slot_refs[0]);
      const universe = new Set(slot?.kind === 'select' ? slot.items.map((i) => i.item_id) : []);
      const bad =
        (keyA.kind === 'select' && keyA.accepted_item_ids.some((id) => !universe.has(id))) ||
        (keyB.kind === 'select' && keyB.accepted_item_ids.some((id) => !universe.has(id)));
      if (bad) {
        verdicts.set(unit.scoring_unit_id, {
          status: 'conflict',
          detail: 'solver emitted an item id outside the declared universe',
        });
        continue;
      }
    }
    const authorKey = authorAdmissionKey(unit.seeded_criterion);
    // 第 2 片：该槽冻结的 answer_shape（同一比较核心；无声明 → null
    // → 旧路径逐字不变）。
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
      if (
        authorKey == null ||
        !(await authorKeyAccepts(unit, keyA, declaredShape ?? undefined)) ||
        !(await authorKeyAccepts(unit, keyB, declaredShape ?? undefined))
      ) {
        verdicts.set(unit.scoring_unit_id, {
          status: 'seed_mismatch',
          detail: 'the author key does not accept the solver answer',
        });
        continue;
      }
      const agreement = keysAgree(keyA, keyB, unit.blank_normalization, declaredShape);
      verdicts.set(
        unit.scoring_unit_id,
        agreement.agree && agreement.key != null
          ? { status: 'agreed', key: authorKey }
          : { status: 'conflict', detail: agreement.detail ?? 'independent solves disagree' },
      );
    } else {
      const agree = keysAgree(keyA, keyB, unit.blank_normalization, declaredShape);
      if (!agree.agree || agree.key == null) {
        verdicts.set(unit.scoring_unit_id, {
          status: 'conflict',
          detail: `independent solves disagree: ${agree.detail}`,
        });
        continue;
      }
      verdicts.set(unit.scoring_unit_id, { status: 'agreed', key: agree.key });
    }
    probeCandidates.set(unit.scoring_unit_id, {
      equivalent_forms: [],
      typical_wrong: (outA.typical_wrong ?? []).map((w) => ({
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
      outputs: [first.output, second.output],
      solve_a: first.receipt,
      solve_b: second.receipt,
      probe_candidates: probeCandidates,
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
      units: solverUnits(definition, 0, { exposePrinted: false }),
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

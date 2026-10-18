// YUK-1445 (Stage 1 / G1) — dual independent solve + source cross-check.
//
// 两次解题互相隔离：各自经 runTask 起全新任务（不复用 session/replay，
// 第二次看不到第一次输出，也看不到参考答案/学习者作答/印出判分规则文本 ——
// solve 输入里根本不携带这些面：rule_reference.statement_md 等印出文本
// 只进独立的 source_crosscheck lane）。第二解的模型/提供方可由 caller 覆盖
// （异源与否是 owner 决策，配置面在 job 层；缺省同一 registry 模型、独立
// 上下文）。
//
// 一致性只比 typed 键（stable id 集合 / 归一化文本集 / 数值+容差），绝不解析
// 答案文本铸键。印出答案原文只在独立的 source_crosscheck mode 里作交叉核验
// —— conflict/unknown 都阻断准入。

import { eq } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { normalizeBlankText } from '@/core/schema/assessment/grade';
import { isPublicSharedMaterial } from '@/core/schema/assessment/materials';
import { describeSelectItem } from '@/core/schema/assessment/response';
import type { BlankNormalizationT, ScoringUnitCriterionT } from '@/core/schema/assessment/scoring';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskOutput } from '../../tasks/parse-output';
import {
  QuestionAdmissionSolveInput,
  type QuestionAdmissionSolveInputT,
  type QuestionAdmissionSolveOutputT,
  type QuestionAdmissionSolveUnitOutputT,
  type QuestionAdmissionSolveUnitT,
  QuestionAdmissionSourceCrosscheckInput,
  QuestionAdmissionSourceCrosscheckOutput,
  type QuestionAdmissionSourceCrosscheckOutputT,
  parseQuestionAdmissionSolveModelOutput,
} from '../../tasks/question-admission-solve';
// YUK-1445 — Provider/TaskTextResult 经 verify-framework（既有 server/ai
// 边持有者）取，taskInputHash 经 judge-execution-provenance 的既有复导出
// 取 —— 不新增 capability→server/ai 依赖边（audit:capability-boundaries）。
import { taskInputHash } from '../judge/judge-execution-provenance';
import type { Provider, TaskTextResult } from '../quiz/verify-framework';
import type { PracticeTaskRunFn } from '../task-runtime';
import type { AdmissionUnitSpec, QuestionAdmissionDefinition } from './contract';

export type { Provider } from '../quiz/verify-framework';

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
  solve_a: AdmissionSolveReceipt;
  solve_b: AdmissionSolveReceipt;
  /** probe candidates emitted by solve A（等价形态 + 典型错答）。 */
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

/** Parse failed after the provider returned. The receipt is the paid task run when it can be sealed. */
class UnparsedSolveError extends Error {
  readonly receipt?: AdmissionSolveReceipt;
  constructor(message: string, receipt?: AdmissionSolveReceipt) {
    super(message);
    this.name = 'UnparsedSolveError';
    this.receipt = receipt;
  }
}

/** task_run 收据密封：必须存在、成功、kind 匹配、input hash 精确绑定本次请求体。 */
async function sealTaskRun(
  db: Db,
  payload: unknown,
  result: TaskTextResult,
  output: unknown,
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
    receipt.task_kind !== QUESTION_ADMISSION_TASK_KIND ||
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

function solverUnits(
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

function solverParts(
  definition: QuestionAdmissionDefinition,
): QuestionAdmissionSolveInputT['parts'] {
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
          m != null && isPublicSharedMaterial(m) && m.content_md != null,
      )
      .map((m) => ({ material_id: m.material_id, text_md: m.content_md ?? '' })),
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

const STRICT_BLANK_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** A whole decimal token. Exponents, units and leading zeros stay unequal. */
function parseStrictBlankNumber(text: string): number | null {
  if (!STRICT_BLANK_NUMBER.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function textEqualsExpected(
  accepted: readonly string[],
  expected: number,
  normalization: BlankNormalizationT | null,
): boolean {
  if (accepted.length === 0) return false;
  const norm = normalization ?? {
    version: 'n/a',
    nfkc: false,
    trim_outer: true,
    casefold: false,
    collapse_whitespace: false,
    ignore_punctuation: false,
    character_variants: [],
  };
  return accepted.every((text) => {
    const value = parseStrictBlankNumber(normalizeBlankText(text, norm));
    return value != null && value === expected;
  });
}

function bridgeBlankKinds(
  a: AdmissionKey,
  b: AdmissionKey,
  normalization: BlankNormalizationT | null,
): { agree: boolean; detail?: string; key?: AdmissionKey } | null {
  const text = a.kind === 'blank_text' ? a : b.kind === 'blank_text' ? b : null;
  const numeric = a.kind === 'blank_numeric' ? a : b.kind === 'blank_numeric' ? b : null;
  if (text == null || numeric == null) return null;
  if (numeric.expected_unit != null) {
    return { agree: false, detail: 'numeric unit has no textual counterpart' };
  }
  if (!textEqualsExpected(text.accepted, numeric.expected, normalization)) {
    return {
      agree: false,
      detail: `blank text/numeric ${text.accepted.join('|')} vs ${numeric.expected}`,
    };
  }
  // Comparison only. A seeded author key replaces this before anything is published.
  return { agree: true, key: text };
}

function keysAgree(
  a: AdmissionKey,
  b: AdmissionKey,
  normalization: BlankNormalizationT | null,
): { agree: boolean; detail?: string; key?: AdmissionKey } {
  if (a.kind !== b.kind) {
    const bridged = bridgeBlankKinds(a, b, normalization);
    if (bridged != null) return bridged;
    return { agree: false, detail: `key kind ${a.kind} vs ${b.kind}` };
  }
  if (a.kind === 'select' && b.kind === 'select') {
    const sa = [...a.accepted_item_ids].sort();
    const sb = [...b.accepted_item_ids].sort();
    return sa.length === sb.length && sa.every((id, i) => id === sb[i])
      ? { agree: true, key: a }
      : { agree: false, detail: `select key ${sa.join(',')} vs ${sb.join(',')}` };
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
    // 双方 accepted 的归一化并集一致 = 等价（各自多余变体必须是对方已接受的）。
    const allA = na.every((t) => nb.includes(t));
    const allB = nb.every((t) => na.includes(t));
    if (allA && allB) return { agree: true, key: a };
    return { agree: false, detail: `blank_text ${na.join('|')} vs ${nb.join('|')}` };
  }
  if (a.kind === 'blank_numeric' && b.kind === 'blank_numeric') {
    if ((a.expected_unit ?? null) !== (b.expected_unit ?? null)) {
      return {
        agree: false,
        detail: `expected_unit ${a.expected_unit ?? '∅'} vs ${b.expected_unit ?? '∅'}`,
      };
    }
    // 容差同型才可互证：absolute/relative 语义不同型 ⇒ 不视为等价，不合并铸键。
    if (a.tolerance.kind !== b.tolerance.kind) {
      return {
        agree: false,
        detail: `tolerance kind ${a.tolerance.kind} vs ${b.tolerance.kind}`,
      };
    }
    const tolOf = (t: { value?: number; ratio?: number }) => t.value ?? t.ratio ?? 0;
    const tolA = tolOf(a.tolerance);
    const tolB = tolOf(b.tolerance);
    const within = (
      x: number,
      y: number,
      tolerance: { kind: 'absolute'; value: number } | { kind: 'relative'; ratio: number },
    ) =>
      tolerance.kind === 'absolute'
        ? Math.abs(x - y) <= tolerance.value
        : y === 0
          ? x === y
          : Math.abs(x - y) / Math.abs(y) <= tolerance.ratio;
    const ok =
      within(a.expected, b.expected, b.tolerance) && within(b.expected, a.expected, a.tolerance);
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
  return { agree: false, detail: 'uncomparable key kinds' };
}

function keyFromAnswer(
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

/** seeded 判据 vs 双解达成键：seed 存在 ⇒ 必须一致才可准入。数值与文本只在数值相等时互认。 */
function seedMatches(
  seed: ScoringUnitCriterionT,
  key: AdmissionKey,
  normalization: BlankNormalizationT | null,
): boolean {
  if (seed.kind === 'select_key' && key.kind === 'select') {
    const a = [...seed.accepted_item_ids].sort();
    const b = [...key.accepted_item_ids].sort();
    return a.length === b.length && a.every((id, i) => id === b[i]);
  }
  if (seed.kind === 'blank_key' && key.kind === 'blank_text' && seed.key.kind === 'text') {
    const norm = seed.key.normalization;
    const as = [...new Set(seed.key.accepted.map((t) => normalizeBlankText(t, norm)))].sort();
    const bs = [...new Set(key.accepted.map((t) => normalizeBlankText(t, norm)))].sort();
    return as.length === bs.length && as.every((t, i) => t === bs[i]);
  }
  if (seed.kind === 'blank_key' && key.kind === 'blank_numeric' && seed.key.kind === 'text') {
    if (key.expected_unit != null) return false;
    return textEqualsExpected(seed.key.accepted, key.expected, seed.key.normalization);
  }
  if (seed.kind === 'blank_key' && key.kind === 'blank_text' && seed.key.kind === 'numeric') {
    if (seed.key.expected_unit != null) return false;
    return textEqualsExpected(key.accepted, seed.key.expected, normalization);
  }
  if (seed.kind === 'blank_key' && key.kind === 'blank_numeric' && seed.key.kind === 'numeric') {
    if ((seed.key.expected_unit ?? null) !== (key.expected_unit ?? null)) return false;
    // 容差同型且不得放宽：key 的容差宽于 seed ⇒ 视为不等价（不 mint 更宽容差）。
    const seedTol = seed.key.tolerance;
    if (seedTol.kind !== key.tolerance.kind) return false;
    const seedBound = seedTol.kind === 'absolute' ? seedTol.value : seedTol.ratio;
    const keyBound = key.tolerance.kind === 'absolute' ? key.tolerance.value : key.tolerance.ratio;
    if (keyBound > seedBound) return false;
    const diff = Math.abs(seed.key.expected - key.expected);
    return seedTol.kind === 'absolute'
      ? diff <= seedTol.value
      : seed.key.expected === 0
        ? diff === 0
        : diff / Math.abs(seed.key.expected) <= seedTol.ratio;
  }
  return false;
}

async function runSolvePass(
  db: Db,
  runTask: PracticeTaskRunFn,
  subjectProfile: SubjectProfile | undefined,
  payload: QuestionAdmissionSolveInputT,
  override?: { provider?: Provider; model?: string },
): Promise<{ output: QuestionAdmissionSolveOutputT; receipt: AdmissionSolveReceipt }> {
  const result = await runTask(QUESTION_ADMISSION_TASK_KIND, payload, {
    ...(subjectProfile != null ? { subjectProfile } : {}),
    ...(override != null ? { override } : {}),
  });
  const raw = result.structured_output != null ? result.structured_output : result.text;
  try {
    const output = parseQuestionAdmissionSolveModelOutput(raw, payload.units);
    return { output, receipt: await sealTaskRun(db, payload, result, output) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const taskRunId = result.task_run_id;
    let receipt: AdmissionSolveReceipt | undefined;
    if (taskRunId != null) {
      try {
        receipt = await sealTaskRun(db, payload, result, raw);
      } catch {
        receipt = undefined;
      }
    }
    const marked =
      taskRunId != null && !detail.includes(`task_run_id=${taskRunId}`)
        ? `${detail};task_run_id=${taskRunId}`
        : detail;
    throw new UnparsedSolveError(marked, receipt);
  }
}

/**
 * 双盲独立解题 + （可选）印出答案 crosscheck。
 * 任一求解失败/收据无法密封 ⇒ ok:false + 已付费收据（调用方按 pending/infra
 * 处理，证据不丢）。
 */
export async function runDualSolve(
  db: Db,
  definition: QuestionAdmissionDefinition,
  deps: {
    runTask: PracticeTaskRunFn;
    subjectProfile?: SubjectProfile;
    /** OPEN owner decision：异源与否由配置决定（默认同一配置模型、独立上下文）。 */
    solver2?: { provider?: Provider; model?: string } | null;
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

  const receipts: AdmissionSolveReceipt[] = [];
  let first: { output: QuestionAdmissionSolveOutputT; receipt: AdmissionSolveReceipt };
  try {
    first = await runSolvePass(db, deps.runTask, deps.subjectProfile, payloadA);
  } catch (error) {
    const receipt = error instanceof UnparsedSolveError ? error.receipt : undefined;
    return {
      ok: false,
      error: `solve_a failed: ${error instanceof Error ? error.message : String(error)}`,
      receipts: receipt != null ? [...receipts, receipt] : receipts,
    };
  }
  receipts.push(first.receipt);
  let second: { output: QuestionAdmissionSolveOutputT; receipt: AdmissionSolveReceipt };
  try {
    second = await runSolvePass(
      db,
      deps.runTask,
      deps.subjectProfile,
      payloadB,
      deps.solver2 ?? undefined,
    );
  } catch (error) {
    const receipt = error instanceof UnparsedSolveError ? error.receipt : undefined;
    return {
      ok: false,
      error: `solve_b failed: ${error instanceof Error ? error.message : String(error)}`,
      receipts: receipt != null ? [...receipts, receipt] : receipts,
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
            ? 'free units carry no deterministic key (admitted model executor lane is out of scope)'
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
    const agree = keysAgree(keyA, keyB, unit.blank_normalization);
    if (!agree.agree || agree.key == null) {
      verdicts.set(unit.scoring_unit_id, {
        status: 'conflict',
        detail: `independent solves disagree: ${agree.detail}`,
      });
      continue;
    }
    if (
      unit.seeded_criterion != null &&
      !seedMatches(unit.seeded_criterion, agree.key, unit.blank_normalization)
    ) {
      verdicts.set(unit.scoring_unit_id, {
        status: 'seed_mismatch',
        detail: 'agreed key conflicts with the seeded typed criterion',
      });
      continue;
    }
    verdicts.set(unit.scoring_unit_id, {
      status: 'agreed',
      key: authorAdmissionKey(unit.seeded_criterion) ?? agree.key,
    });
    probeCandidates.set(unit.scoring_unit_id, {
      equivalent_forms: (outA.equivalent_forms ?? []).map((f) => ({
        ...(f.item_ids != null ? { item_ids: f.item_ids } : {}),
        ...(f.text != null ? { text: f.text } : {}),
      })),
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
      solve_a: first.receipt,
      solve_b: second.receipt,
      probe_candidates: probeCandidates,
    },
  };
}

// ---------- 印出答案 crosscheck（evidence only，不铸键） ----------

export interface SourceCrosscheckResult {
  receipt: AdmissionSolveReceipt;
  per_unit: Map<string, { status: 'consistent' | 'conflict' | 'unknown'; reason_md?: string }>;
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

/** 印出答案原文仅作 crosscheck —— conflict/unknown 阻断准入（绝不解析铸键）。 */
export async function runSourceCrosscheck(
  db: Db,
  definition: QuestionAdmissionDefinition,
  keys: Map<string, AdmissionKey>,
  deps: { runTask: PracticeTaskRunFn; subjectProfile?: SubjectProfile },
): Promise<SourceCrosscheckResult | null> {
  if (definition.source_answers.length === 0 || keys.size === 0) return null;
  const payload = QuestionAdmissionSourceCrosscheckInput.parse({
    mode: 'source_crosscheck',
    parts: solverParts(definition),
    // crosscheck lane：印出文本经显式 source_answers 给，不再经 unit 字段重复。
    units: solverUnits(definition, 0, { exposePrinted: false }),
    source_answers: definition.source_answers.map((s) => ({
      scoring_unit_id: s.unit_id ?? null,
      reference_md: s.reference_md,
      ...(s.locator != null ? { locator: s.locator } : {}),
    })),
    proposals: [...keys.entries()].map(([unitId, key]) => ({
      scoring_unit_id: unitId,
      answer_summary_md: describeKey(key, definition, unitId),
    })),
  });
  const result = await deps.runTask(QUESTION_ADMISSION_TASK_KIND, payload, {
    ...(deps.subjectProfile != null ? { subjectProfile: deps.subjectProfile } : {}),
  });
  const output: QuestionAdmissionSourceCrosscheckOutputT =
    result.structured_output !== undefined
      ? QuestionAdmissionSourceCrosscheckOutput.parse(result.structured_output)
      : parseTaskOutput(
          result.text,
          QUESTION_ADMISSION_TASK_KIND,
          QuestionAdmissionSourceCrosscheckOutput,
        );
  const receipt = await sealTaskRun(db, payload, result, output);
  const per_unit = new Map(
    output.per_unit.map(
      (entry) =>
        [
          entry.scoring_unit_id,
          {
            status: entry.status,
            ...(entry.reason_md != null ? { reason_md: entry.reason_md } : {}),
          },
        ] as const,
    ),
  );
  return { receipt, per_unit };
}

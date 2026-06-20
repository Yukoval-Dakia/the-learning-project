// YUK-361 Phase 3 Step A (Task 7) — 候选信号收集 collectCandidateSignals。
//
// 把非到期候选题/卷变成 `SelectionCandidateSignal[]`（core/selection-signals.ts 定义的
// 形状）。**零选题行为变更**：本模块只读 DB（mastery_state / item_calibration）+ 复用
// core 数学，**不接进 composeDailyStream / 不改可见选题顺序**（接线是 Step C，roadmap
// Task 8 余）。
//
// 权威 spec：
//   - docs/superpowers/plans/2026-06-16-phase3-randomized-mfi-impl.md（Step A）
//   - docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md Task 7
//   - ADR-0042 §1/§2 + 编排档2 amendment（L1 信号集扩充 §9.2）
//   - ADR-0035（三轴正交：FSRS=R 调度 / mastery_state=p(L) 诊断 / item_calibration=b 锚）
//
// 严守只读契约（item-更新半边锁死 G4）：本模块**永不写** item_calibration / mastery_state。
// b 锚只读 track='hard'（软轨 b 永不进 p(L)/调度，ADR-0035）。

import type { QuestionKindT } from '@/core/schema/judge-routing';
import {
  EARLY_KLP_ENABLED,
  EARLY_KLP_N,
  type SelectionCandidateSignal,
  diagnosticScore,
  klpScore,
  mfiScore,
} from '@/core/selection-signals';
import { difficultyToLogitB } from '@/core/theta';
import { THETA_GRID_ENABLED, type ThetaGridPosterior, klpScoreFromGrid } from '@/core/theta-grid';
import type { Db, Tx } from '@/db/client';
import { item_calibration, item_family_calibration, mistake_variant, question } from '@/db/schema';
import { batchResolveFamilyKeys } from '@/server/mastery/family-key';
import {
  type FamilyCalibrationRow,
  effectiveFamilyB,
} from '@/server/mastery/personalized-difficulty';
import { effectiveB } from '@/server/mastery/recalibration';
import { effectiveThetaForKc, getMasteryState } from '@/server/mastery/state';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { MISCONCEPTION_RECURRENCE_ENABLED } from './selection-constants';
import { rotationClassForKind } from './variant-rotation';

type DbLike = Db | Tx;

/**
 * 候选输入。一条候选 = 一题或一卷。
 *   - 题候选携带 kind / knowledgeIds / difficulty（用于 θ̂ 聚合、recall 路由、b 弱锚兜底）。
 *   - 卷候选只带 role（paper）——卷的内部题信号由组卷层处理，本层只透传 role，不算 MFI。
 */
export interface CandidateInput {
  refKind: 'question' | 'paper';
  refId: string;
  role: SelectionCandidateSignal['role'];
  /** 题候选必填；卷候选省略。recall 路由 + 题型档归类用。 */
  kind?: QuestionKindT;
  /** 题候选挂的全部 KC。空/缺 → θ̂/precision 留 undefined（无个体能力锚）。 */
  knowledgeIds?: string[];
  /** 题候选的 1-5 难度档（兜底 b 弱锚来源）。缺 → 无 b。 */
  difficulty?: number;
  /**
   * YUK-372 L3 — question.source（family_key 解析所需，与 kind + knowledgeIds[0] 共同成键）。
   * 缺 → 跳过家族查询 → 纯 effectiveB（NO-OP，向后兼容）。
   */
  source?: string;
}

/**
 * b 锚来源标注（type SelectionCandidateSignal 无 b_source 字段——这是有意的：core 信号
 * 形状只承载 IRT 量，不承载 provenance）。Step C 的 sampler 需要据来源给弱锚 b 降权
 * （difficulty_proxy 的 b 是序数当 interval 的占位、非真值，VERIFY:difficulty-logit-map
 * REFUTED），故本层返回 `CollectedSignal` = 信号 + `bSource` 旁路标注。
 *   - 'item_calibration'：来自 item_calibration.b（track='hard'，真锚）。
 *   - 'difficulty_proxy'：来自 difficultyToLogitB(difficulty)（弱锚，Step C 降权）。
 *   - 'none'：既无标定也无 difficulty → b 留 undefined（无难度信息）。
 */
export type BSource = 'item_calibration' | 'difficulty_proxy' | 'none';

/**
 * 收集层返回类型：core 信号 + b 来源旁路标注 + 选题评分快照。
 *
 * `mfiScore` / `diagnosticScore` 是收集时算好的快照（复用 core 数学，不在此重算）——
 * recall-locked 候选**不算**（recall 题重背，不进 MFI/sampler 评分，ADR-0042:36/ADR-0030），
 * 故这两个字段对 recall 候选恒为 undefined。无 thetaHat/b（缺 KC 或缺难度）时也为 undefined。
 *
 * A3 (YUK-435)：`mfiScore` 字段承载的是**当前生效准则**算出的信息分——点 MFI（默认 /
 * warm KC）或 KLP（EARLY_KLP_ENABLED && 冷启 KC）。`scoreKind`（继承自 core 信号 type）
 * 旁路标注用了哪种。flag OFF（默认）恒为点 MFI，逐位等同今天。字段名保留 `mfiScore`
 * 是为不破坏 Step C sampler 既有读点（语义已泛化为「信息分」）。
 */
export type CollectedSignal = SelectionCandidateSignal & {
  bSource: BSource;
  /** 信息分快照（点 MFI = p(1−p)，p=σ(θ̂−b)；或 KLP 后验加权积分）。recall-locked / 缺 θ̂或b → undefined。 */
  mfiScore?: number;
  /** 诊断评分快照 = MFI × 不确定性降权。recall-locked / 缺 θ̂/b/precision → undefined。 */
  diagnosticScore?: number;
};

/** 冷启兜底（mastery_state 无行）：θ̂=0（logit 原点先验中性），precision=1（弱先验 1 单位信息，SE=1）。 */
const COLD_START_THETA = 0;
const COLD_START_PRECISION = 1;
/** A3 (YUK-435) 冷启兜底 evidence_count=0（< EARLY_KLP_N ⇒ 落 KLP 冷启段）。never-seen KC 无作答证据。 */
const COLD_START_EVIDENCE = 0;

/**
 * 多 KC θ̂ 聚合：取最弱 KC（min theta_hat）。ADR-0042:36「多 KC 用 θ̂_min」——选题
 * 关心「这道题最薄弱的那个前提知识点掌握得多差」，故 thetaHat=θ̂_min，thetaPrecision
 * 取该最弱 KC 自己的 precision（不是跨 KC 平均——选题信息量评估锚在最弱环节）。
 *
 * 读每个 KC 的 mastery_state（getMasteryState，'knowledge' 维），冷启行（null）兜底
 * θ̂=0 / precision=1。无 KC（空 knowledgeIds）→ 返回 undefined/undefined（无个体能力锚，
 * 评分层退化为无 θ̂ 状态）。
 *
 * A2 (YUK-434) — the per-KC θ_hat is the OFFSET θ_KC; the value compared/returned is
 *   the EFFECTIVE theta = θ_global(domain-of-KC) + θ_KC (effectiveThetaForKc). Now
 *   LIVE (HIERARCHICAL_ELO_ENABLED=true, P1 go-live YUK-361): a new KC of a strong
 *   domain compares at its inherited effective ability rather than cold 0; an orphan /
 *   domain-unresolvable KC degrades to θ_KC (effectiveThetaForKc catches + returns θ_KC).
 *   With the flag OFF (still a valid mocked-false regression) effectiveThetaForKc
 *   returns θ_KC UNCHANGED and resolves no domain/global row → read path BYTE-IDENTICAL
 *   to single-layer (weakest-by-θ_hat, same precision).
 *
 * A3 (YUK-435) — also surface the WEAKEST KC's `evidence_count` (the per-KC cold-start
 *   regime gate for KLP scoring) from the row ALREADY READ here (zero new query). The
 *   evidence_count tracks the SAME KC whose θ̂/precision is returned (the θ̂_min KC), so
 *   the KLP-vs-MFI decision and the score it produces are anchored on one consistent KC.
 *   Cold start (no row / empty KCs) → 0 (< EARLY_KLP_N → cold regime). n=1-legal:
 *   evidence_count is a single-learner sufficient statistic, KLP is a selection
 *   criterion (no estimation), so one learner's count is the whole signal.
 */
async function aggregateWeakestKc(
  db: DbLike,
  knowledgeIds: string[],
): Promise<{
  thetaHat?: number;
  thetaPrecision?: number;
  evidenceCount: number;
  // A4 inc-2 (YUK-436) — the WEAKEST KC's grid posterior + its θ_global anchor, captured
  // for the SAME KC whose θ̂/precision/evidence is returned (one consistent KC). null grid
  // (no row / shadow write never ran) → selection falls back to the Gaussian KLP / MFI path.
  gridPosterior?: ThetaGridPosterior | null;
  thetaGlobal?: number;
}> {
  if (knowledgeIds.length === 0) {
    return { thetaHat: undefined, thetaPrecision: undefined, evidenceCount: 0 };
  }
  let weakestTheta = Number.POSITIVE_INFINITY;
  let weakestPrecision = COLD_START_PRECISION;
  let weakestEvidence = COLD_START_EVIDENCE;
  let weakestGrid: ThetaGridPosterior | null = null;
  let weakestThetaGlobal = 0;
  for (const kid of knowledgeIds) {
    const row = await getMasteryState(db, kid, 'knowledge');
    const thetaKc = row?.theta_hat ?? COLD_START_THETA;
    // Effective theta (θ_global + θ_KC). Flag off → === thetaKc (bit-identical).
    const theta = await effectiveThetaForKc(db, kid, thetaKc);
    const precision = row?.theta_precision ?? COLD_START_PRECISION;
    const evidence = row?.evidence_count ?? COLD_START_EVIDENCE;
    if (theta < weakestTheta) {
      weakestTheta = theta;
      weakestPrecision = precision;
      weakestEvidence = evidence;
      weakestGrid = row?.theta_grid_json ?? null;
      // θ_global = effective − θ_KC offset (effectiveThetaForKc folds θ_global in; subtract
      // the offset back out). Flag off → effective === θ_KC → θ_global = 0 (grid over raw b).
      weakestThetaGlobal = theta - thetaKc;
    }
  }
  return {
    thetaHat: weakestTheta,
    thetaPrecision: weakestPrecision,
    evidenceCount: weakestEvidence,
    gridPosterior: weakestGrid,
    thetaGlobal: weakestThetaGlobal,
  };
}

/**
 * 读 b 锚：item_calibration（question_id=refId AND track='hard'）的 effectiveB =
 * b_calib ?? b_anchor ?? b（YUK-361 Phase 6 read-compat，Task 11 step 5）。有非 NULL 值
 * → 真锚（标 'item_calibration'）。否则 difficulty 在场 → difficultyToLogitB 弱锚
 * （'difficulty_proxy'）。两者皆无 → 'none'。
 *
 * **NO-OP today**：b_calib 攒够标签前 NULL，b_anchor 由 migration 0038 从既有 b 回填，故
 * effectiveB 当前等于原 b（接线安全，零行为变更）。重标定首次 firm-up b_calib 后，选题层
 * 自动用去偏 b——无需再改本处。家族 delta 组合（effectiveFamilyB）是 Phase 5 的独立接缝，
 * 本处只解析列层 b（见 recalibration.ts effectiveB 文档的家族组合说明）。
 *
 * 三列皆 nullable（冷启行可能有 row 但全 NULL）——effectiveB 返回 null 时照样落兜底链。
 * 读模式对齐 state.ts updateThetaForAttempt（track='hard' only）。
 */
async function resolveBAnchor(
  db: DbLike,
  refId: string,
  difficulty: number | undefined,
): Promise<{ b?: number; bSource: BSource }> {
  const calRows = await db
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
    })
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, refId), eq(item_calibration.track, 'hard')))
    .limit(1);
  const calB = effectiveB(calRows[0]);
  if (calB !== null) {
    return { b: calB, bSource: 'item_calibration' };
  }
  if (difficulty !== undefined) {
    return { b: difficultyToLogitB(difficulty), bSource: 'difficulty_proxy' };
  }
  return { b: undefined, bSource: 'none' };
}

// ─────────────────────────────────────────────────────────────────────────────
// P2 D2 / A8 — misconceptionRecurrence（错误观念复发度）选题信号。
//
// 填补 candidate-signals.ts §9.2 三 first-class 信号里 `misconceptionRecurrence` 这一格
// （examRelevance / transferGap 仍无 cheap reader，留 undefined）。
//
// 权威 spec：
//   - ADR-0042 编排档2 amendment（GPT 研究稿 §9.2）——选题不止 MFI 中心。
//   - core/selection-signals.ts:53「错题家族复发频次」computation-deferred 注。
//
// 消费方（live，本处只产值不碰）：selection-orchestrator.ts:97
//   `bucketUnit(sig.misconceptionRecurrence)` → SelectionOrchestratorTask LLM prompt
//   （softmax-selection.ts tryLlmOrchestration）。**选题专属**——此值绝不进
//   updateThetaForAttempt / p(L) / FSRS（红线 #1；updateThetaForAttempt 的 input 形状
//   UpdateThetaForAttemptInput 里根本没有承载它的字段，结构性切断）。
//
// 单用户工具（CLAUDE.md Auth：「single-user tool；no per-user auth」）——schema 里
// mistake_variant / question / mastery_state 全无 user_id 列。故每条 mistake_variant 行
// 就是 THIS learner 自己的错误记录。本信号是**纯 per-learner SELF-STATE tally**
// （sufficient-statistic 式计数），归一化常数 owner-fixed（module const，同其它选题权重），
// **绝不估计任何 cross-examinee 量**（admissibility HARD，n=1 admissible）。
//
// 链接（KC-based，prompt PREFER）：候选题触及 KC 集 K（cand.knowledgeIds）。
//   1. 找触及任一 kc∈K 的题：question.knowledge_ids @> [kc]（已有 GIN 索引）。
//   2. 这些题上的错误：mistake_variant.parent_question_id ∈ 那些题 id，按 cause_category
//      group + count（每行 = 该错因家族的一次复发）。
//   3. 复发分 = 跨 cause_category 的 MAX 计数（这道题最常复发的那个错误观念有多顽固）。
//   4. 归一化：min(1, maxCount / NORMALIZATION_CONST)（owner-fixed const，非学习/估计量）。
//   无任何错误数据（learner 在候选 KC 上无 cause 记录）→ undefined（NEVER zero-fill：
//   undefined=「无数据」，0=「测得为零」——评分层据此 MFI-only 退化 vs 当硬零处理）。
// ─────────────────────────────────────────────────────────────────────────────

// Dark-ship flag MISCONCEPTION_RECURRENCE_ENABLED lives in ./selection-constants (imported
// above) — a pure IO-free module so tests can mock just that export (EARLY_KLP pattern).
// Default false → misconceptionRecurrence undefined for all → orchestrator prompt +
// mfiScore/diagnosticScore byte-identical to today (the aggregate read is never issued).

/**
 * Owner-fixed normalization constant for misconceptionRecurrence (NOT a learned / estimated
 * quantity — a module const, same class as the other selection weights). The raw signal is
 * this learner's MAX per-cause-family recurrence count over questions probing the candidate's
 * KCs; we map it onto [0,1] by `min(1, count / RECURRENCE_NORM)`. RECURRENCE_NORM=5 means
 * "5+ recurrences of the same misconception family on this candidate's KCs ⇒ saturated (1.0)".
 * Owner-tunable like a weight; it is NOT inferred from any cross-examinee distribution.
 */
const RECURRENCE_NORM = 5;

/**
 * Per-learner cross-attempt cause-family recurrence for a candidate touching KC set K.
 *
 * SELF-STATE sufficient statistic (single-user tool → every mistake_variant row is THIS
 * learner's). One bounded aggregate read (NOT a new service): a single GROUP BY over
 * mistake_variant joined to question on parent_question_id, filtered to rows whose parent
 * question carries any kc∈K (jsonb `@>` containment, GIN-indexed), with a non-null
 * cause_category AND status='active' (only CONFIRMED-ACCEPTED mistakes count — draft /
 * dismissed / broken are excluded; see the inline WHERE-clause comment for the lifecycle
 * rationale). Returns the MAX per-cause-family count normalized to [0,1] via the owner-fixed
 * RECURRENCE_NORM.
 *
 * NEVER zero-fill — undefined (no-data) returns, distinct from a measured 0:
 *   - empty K (candidate has no KCs) → undefined (no KC anchor → no linkage).
 *   - no ACTIVE mistake_variant rows on those KCs with a cause_category → undefined (no
 *     confirmed cause data — e.g. only draft/dismissed/broken rows, or none at all).
 * A measured count ≥1 maps to a finite (0,1] value that rises with the recurrence count.
 */
async function aggregateMisconceptionRecurrence(
  db: DbLike,
  knowledgeIds: string[],
): Promise<number | undefined> {
  if (knowledgeIds.length === 0) return undefined;
  // OR of jsonb containments: question probes ANY of the candidate's KCs.
  const kcContainment = sql.join(
    knowledgeIds.map((kc) => sql`${question.knowledge_ids} @> ${JSON.stringify([kc])}::jsonb`),
    sql` OR `,
  );
  // GROUP BY cause_category over this learner's mistakes on those questions; take MAX count.
  // count(*) is the per-cause-family recurrence tally (each mistake_variant row = one
  // recurrence of that cause family). The outer max() over the grouped counts is the single
  // "most-recurring misconception probed by this candidate" scalar.
  //
  // STATUS FILTER (correctness): only status='active' rows are CONFIRMED-ACCEPTED mistakes
  // — the lifecycle (schema.ts mistake_variant / business.ts MistakeVariant enum) is:
  //   draft     → AI-proposed, pending user acceptance (cause_category is set at INSERT
  //               while still 'draft' — see variant_gen.ts — so a draft row carries a
  //               non-null cause but is NOT yet a confirmed mistake);
  //   active    → user accepted + variant materialized (THE confirmed recurrence);
  //   broken    → the generated variant failed VariantVerify pass-2 (drifted / off-target)
  //               — a quality-rejected generation, not a confirmed-accepted recurrence;
  //   dismissed → user rejected the proposal (false-positive cause analysis).
  // dismiss/broken transitions flip status WITHOUT clearing cause_category (proposals/
  // actions.ts sets only status; variant_verify.ts sets only status+failure_reasons), so an
  // un-filtered count inflates the signal with pending / rejected / failed rows. We count
  // ONLY status='active' (mirrors stream-store.ts's variant read), excluding draft +
  // dismissed + broken. (broken is excluded too: it represents a failed VARIANT generation,
  // not a confirmed recurrence the learner accepted.)
  const rows = await db
    .select({
      maxCount: sql<number>`max(grouped.cnt)`,
    })
    .from(
      sql`(
        SELECT count(*)::int AS cnt
        FROM ${mistake_variant}
        JOIN ${question} ON ${question.id} = ${mistake_variant.parent_question_id}
        WHERE ${mistake_variant.cause_category} IS NOT NULL
          AND ${mistake_variant.status} = 'active'
          AND (${kcContainment})
        GROUP BY ${mistake_variant.cause_category}
      ) AS grouped`,
    );
  const maxCount = rows[0]?.maxCount;
  // No grouped rows → max() returns NULL → maxCount null/undefined → no cause data → undefined.
  if (maxCount === null || maxCount === undefined || maxCount <= 0) return undefined;
  // Owner-fixed normalization; rises with recurrence count, saturates at RECURRENCE_NORM.
  return Math.min(1, maxCount / RECURRENCE_NORM);
}

/**
 * 收集一条题候选的信号。
 *
 * YUK-372 L3：`familyRow` 是 collectCandidateSignals 批量解析好的家族校准行（或 null）。在
 * resolveBAnchor 后、mfiScore/diagnosticScore 前叠加 effectiveFamilyB(b, familyRow)。
 * G4 NO-OP-safe：familyRow=null 或 b_delta=0 → effectiveFamilyB 原样返回 b → mfiScore bit-identical。
 * recall-locked / b-absent（bSource='none'）候选：b===undefined 时不叠家族 delta（无 b 可叠）。
 */
async function collectQuestionSignal(
  db: DbLike,
  cand: CandidateInput,
  familyRow: FamilyCalibrationRow | null = null,
): Promise<CollectedSignal> {
  const knowledgeIds = cand.knowledgeIds ?? [];
  const { thetaHat, thetaPrecision, evidenceCount, gridPosterior, thetaGlobal } =
    await aggregateWeakestKc(db, knowledgeIds);
  const { b: columnarB, bSource } = await resolveBAnchor(db, cand.refId, cand.difficulty);
  // 家族 delta 叠加（G4 NO-OP-safe）。b===undefined（bSource='none'）→ 无 b 可叠，保持 undefined。
  const b = columnarB !== undefined ? effectiveFamilyB(columnarB, familyRow) : undefined;

  // recall-eligibility（ADR-0030 by-kind 路由 → recall/application）。
  //   recall（fill_blank/translation）：原题重背，FSRS 测的就是这道 recall item。recall
  //   题**绝不进 MFI/sampler 评分**（换题会污染 FSRS 信号；ADR-0042:36/ADR-0030）——
  //   recallLocked:true 且不算 mfiScore/diagnosticScore。
  //   application：可换变体，进 MFI 评分。
  // kind 缺省（卷候选不会走这里；题候选理应带 kind）时**保守锁 recall（fail CLOSED）**：
  //   undefined kind 意味着我们无法证明这题可换变体（如目标题被硬删、kind 丢失）——
  //   宁可把它当原题重背确定性透传，也不能让一道身份不明的题进 sampler/MFI 而违反铁律③
  //   （recall-locked = 同题永不被抽样/MFI 评分）。这是 review CLUSTER D 的 fail-open→
  //   fail-closed 纠正。
  const recallLocked = cand.kind ? rotationClassForKind(cand.kind) === 'recall' : true;

  // 评分快照：复用 core 数学（mfiScore/klpScore/diagnosticScore，selection-signals.ts），
  // 不在此重算。recall-locked 或缺 θ̂/b 时不算（留 undefined，scoreKind 同样 undefined）。
  //
  // A3 (YUK-435) — cold-start KLP 门控：weakest-KC evidence_count < EARLY_KLP_N 且
  //   EARLY_KLP_ENABLED ⇒ 用 KLP（后验加权 Fisher 网格积分，不押 volatile θ̂ 单点）；
  //   否则点 MFI。`scoreKind` 旁路标注用了哪种准则（provenance）。
  //   FLAG OFF (DEFAULT)：useEarlyKlp 恒 false ⇒ 永远点 MFI ⇒ 选题评分逐位等同今天
  //   （bitwise regression anchor，candidate-signals.db.test.ts 用 toBe 钉死）；scoreKind
  //   只是新增的旁路字段，不改任何既有 score 数值。precision 缺失（无 θ̂ 状态）时 KLP
  //   无法算（需 precision）⇒ 退点 MFI（与今天一致）。
  //
  // A4 inc-2 (YUK-436) — grid→KLP 接线（dark-ship，THETA_GRID_ENABLED 默认 false）：当该 KC
  //   有网格后验（theta_grid_json）且 flag ON 时，**优先**用 klpScoreFromGrid——直接对实际
  //   离散后验加权 Fisher 积分，免去 A3 的 Gaussian(θ̂, thetaSe) 重构（A4「免费 Fisher 选题」
  //   payoff）。FLAG OFF (DEFAULT)：useGrid 恒 false（短路在 gridPosterior 判定前）⇒ 走 A3 老
  //   路径 ⇒ 选题评分逐位等同今天（bitwise anchor 不破——即使行里已有 shadow 网格也不读）。
  //   翻 flag 须 gated on 校准验证（theta-grid.ts 头注 inc-2 deferred）。
  let mfi: number | undefined;
  let diag: number | undefined;
  let scoreKind: SelectionCandidateSignal['scoreKind'];
  if (!recallLocked && thetaHat !== undefined && b !== undefined) {
    // b is already narrowed non-undefined by the enclosing `if`; useGrid only adds the
    // grid-presence gate (THETA_GRID_ENABLED FIRST so flag-off short-circuits before any read).
    const useGrid = THETA_GRID_ENABLED && gridPosterior != null && thetaGlobal !== undefined;
    if (useGrid && gridPosterior != null && thetaGlobal !== undefined) {
      mfi = klpScoreFromGrid(gridPosterior, b, thetaGlobal);
      scoreKind = 'klp_grid';
    } else if (EARLY_KLP_ENABLED && evidenceCount < EARLY_KLP_N && thetaPrecision !== undefined) {
      mfi = klpScore(thetaHat, b, thetaPrecision);
      scoreKind = 'klp';
    } else {
      mfi = mfiScore(thetaHat, b);
      scoreKind = 'mfi';
    }
    if (thetaPrecision !== undefined) {
      diag = diagnosticScore(thetaHat, b, thetaPrecision);
    }
  }

  // P2 D2 / A8 — misconceptionRecurrence（错误观念复发度，选题专属，flag-gated dark-ship）。
  //   FLAG OFF (DEFAULT)：短路在读之前 → 恒 undefined → orchestrator prompt + mfiScore/
  //     diagnosticScore 路径逐位等同今天（NEVER zero-fill）。
  //   FLAG ON：per-learner SELF-STATE tally（aggregateMisconceptionRecurrence）。无数据 →
  //     undefined（NOT 0）。recall-locked 也照常算——它是候选画像的一部分（生产里
  //     recall-locked 在喂 orchestrator 前已被切出，故此值对它实际不被消费；但保持
  //     snapshot 完整、不引入 recall 特例分支）。
  // TODO(flag-on): batch aggregateMisconceptionRecurrence across all candidates (like the
  //   family-calibration read in collectCandidateSignals ~lines 442-453: dedupe the KC keys
  //   then issue ONE IN/containment query) BEFORE flipping MISCONCEPTION_RECURRENCE_ENABLED
  //   to true. Right now this runs per-candidate inside the serial loop (an N+1 aggregate
  //   read). It is harmless while the flag is OFF (default) — the call is short-circuited
  //   before any query — but go-live must not silently ship the N+1.
  const misconceptionRecurrence = MISCONCEPTION_RECURRENCE_ENABLED
    ? await aggregateMisconceptionRecurrence(db, knowledgeIds)
    : undefined;

  return {
    refKind: 'question',
    refId: cand.refId,
    role: cand.role,
    thetaHat,
    thetaPrecision,
    b,
    recallLocked,
    bSource,
    mfiScore: mfi,
    diagnosticScore: diag,
    scoreKind,
    // ─────────────────────────────────────────────────────────────────────────
    // §9.2 / ADR-0042 编排档2 first-class 信号扩充（选题不止 MFI 中心）。
    // NEVER zero-fill——undefined = 「无数据」，0 = 「测得为零」，评分层据此 MFI-only 退化。
    //   - examRelevance（考纲/考点权重）：仍无 cheap reader——SubjectProfileSchema
    //     （profile-schema.ts）无 examWeight/syllabus 字段；无考纲映射数据源。引入 subject
    //     profile 考纲权重表后，在此据 candidate 的 knowledgeIds → 考点权重映射计算。
    //   - misconceptionRecurrence（错误观念复发度）：**已填**（P2 D2 / A8）。flag-gated
    //     dark-ship（MISCONCEPTION_RECURRENCE_ENABLED，默认 false → undefined → orchestrator
    //     prompt byte-identical）。ON 时 aggregateMisconceptionRecurrence 算 per-learner
    //     SELF-STATE 错因家族跨 attempt 复发频次（KC-based linkage），归一化到 0-1（owner-fixed
    //     RECURRENCE_NORM）。无数据 → undefined（见该函数文档）。
    //   - transferGap（迁移缺口）：仍无 cheap reader——mastery_state 按 (subject_kind,
    //     subject_id) 即 per-KC 建键，**无 kind 维度**——同 KC 跨题型掌握差无法从现表 cheap
    //     读出。需先有 per-(KC,kind) 粒度的掌握度（或 family-level calibration）才能算。
    // 不为剩余两个信号自建子系统/查询（缺数据留 undefined + scope discipline）。
    // ─────────────────────────────────────────────────────────────────────────
    examRelevance: undefined,
    misconceptionRecurrence,
    transferGap: undefined,
  };
}

/**
 * 收集一条卷候选的信号。卷只透传 role（paper），不算任何 IRT/MFI 量——卷的内部题信号
 * 由组卷/卷架层处理，选题层把卷当作一个不可拆的 'paper' 候选透传（ADR-0042 卷架旁路）。
 */
function collectPaperSignal(cand: CandidateInput): CollectedSignal {
  return {
    refKind: 'paper',
    refId: cand.refId,
    role: cand.role,
    // 卷无个体 θ̂/b/recall 语义；§9.2 三信号同理留 undefined（卷不进 MFI 画像）。
    bSource: 'none',
  };
}

/**
 * 收集非到期候选的选题信号。纯读（mastery_state / item_calibration），无写、无 LLM。
 *
 * 顺序串行处理（候选数量是「今日非到期候选池」量级，非全库；getMasteryState 是单行点查，
 * 无需并发批读复杂度）。Step C sampler 消费返回的 CollectedSignal[]：据 mfiScore/
 * diagnosticScore softmax 抽样、据 bSource 给弱锚降权、据 recallLocked 切断 recall 喂 MFI。
 */
export async function collectCandidateSignals(
  db: DbLike,
  candidates: CandidateInput[],
): Promise<CollectedSignal[]> {
  // YUK-372 L3 — 批量解析所有题候选的 family_key（kind + knowledgeIds[0] + source），subject
  // 派生单遍内存 walk（NOT per-candidate 32-climb），再一次 IN 查 item_family_calibration →
  // family_key → row Map。G3：这是 **Map sidecar**——绝不 reorder candidates（输出顺序严格
  // 对齐输入），绝不写 item b。
  const questionCands = candidates.filter(
    (c): c is CandidateInput & { kind: QuestionKindT } => c.refKind === 'question',
  );
  const familyKeyByRefId = await batchResolveFamilyKeys(
    db,
    questionCands.map((c) => ({
      questionId: c.refId,
      primaryKnowledgeId: (c.knowledgeIds ?? [])[0],
      kind: c.kind,
      source: c.source,
    })),
  );
  // 去重 family_key（多题共享一个 family）→ 一次 IN 查所有家族行。
  const distinctKeys = Array.from(
    new Set(Array.from(familyKeyByRefId.values()).filter((k): k is string => k !== null)),
  );
  const familyRowByKey = new Map<string, FamilyCalibrationRow>();
  if (distinctKeys.length > 0) {
    const rows = await db
      .select({
        family_key: item_family_calibration.family_key,
        b_delta: item_family_calibration.b_delta,
        evidence_count: item_family_calibration.evidence_count,
        confidence: item_family_calibration.confidence,
        calibrated_n: item_family_calibration.calibrated_n,
      })
      .from(item_family_calibration)
      .where(inArray(item_family_calibration.family_key, distinctKeys));
    for (const r of rows) familyRowByKey.set(r.family_key, r);
  }

  const out: CollectedSignal[] = [];
  for (const cand of candidates) {
    if (cand.refKind === 'paper') {
      out.push(collectPaperSignal(cand));
    } else {
      const fk = familyKeyByRefId.get(cand.refId) ?? null;
      const familyRow = fk !== null ? (familyRowByKey.get(fk) ?? null) : null;
      out.push(await collectQuestionSignal(db, cand, familyRow));
    }
  }
  return out;
}

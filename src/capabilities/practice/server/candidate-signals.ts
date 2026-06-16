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
import { type SelectionCandidateSignal, diagnosticScore, mfiScore } from '@/core/selection-signals';
import { difficultyToLogitB } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { item_calibration } from '@/db/schema';
import { effectiveB } from '@/server/mastery/recalibration';
import { getMasteryState } from '@/server/mastery/state';
import { and, eq } from 'drizzle-orm';
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
 * 收集层返回类型：core 信号 + b 来源旁路标注 + MFI 评分快照。
 *
 * `mfiScore` / `diagnosticScore` 是收集时算好的快照（复用 core 数学，不在此重算）——
 * recall-locked 候选**不算**（recall 题重背，不进 MFI/sampler 评分，ADR-0042:36/ADR-0030），
 * 故这两个字段对 recall 候选恒为 undefined。无 thetaHat/b（缺 KC 或缺难度）时也为 undefined。
 */
export type CollectedSignal = SelectionCandidateSignal & {
  bSource: BSource;
  /** MFI 评分快照 = p(1−p)，p=σ(θ̂−b)。recall-locked / 缺 θ̂或b → undefined。 */
  mfiScore?: number;
  /** 诊断评分快照 = MFI × 不确定性降权。recall-locked / 缺 θ̂/b/precision → undefined。 */
  diagnosticScore?: number;
};

/** 冷启兜底（mastery_state 无行）：θ̂=0（logit 原点先验中性），precision=1（弱先验 1 单位信息，SE=1）。 */
const COLD_START_THETA = 0;
const COLD_START_PRECISION = 1;

/**
 * 多 KC θ̂ 聚合：取最弱 KC（min theta_hat）。ADR-0042:36「多 KC 用 θ̂_min」——选题
 * 关心「这道题最薄弱的那个前提知识点掌握得多差」，故 thetaHat=θ̂_min，thetaPrecision
 * 取该最弱 KC 自己的 precision（不是跨 KC 平均——选题信息量评估锚在最弱环节）。
 *
 * 读每个 KC 的 mastery_state（getMasteryState，'knowledge' 维），冷启行（null）兜底
 * θ̂=0 / precision=1。无 KC（空 knowledgeIds）→ 返回 undefined/undefined（无个体能力锚，
 * 评分层退化为无 θ̂ 状态）。
 */
async function aggregateWeakestKc(
  db: DbLike,
  knowledgeIds: string[],
): Promise<{ thetaHat?: number; thetaPrecision?: number }> {
  if (knowledgeIds.length === 0) {
    return { thetaHat: undefined, thetaPrecision: undefined };
  }
  let weakestTheta = Number.POSITIVE_INFINITY;
  let weakestPrecision = COLD_START_PRECISION;
  for (const kid of knowledgeIds) {
    const row = await getMasteryState(db, kid, 'knowledge');
    const theta = row?.theta_hat ?? COLD_START_THETA;
    const precision = row?.theta_precision ?? COLD_START_PRECISION;
    if (theta < weakestTheta) {
      weakestTheta = theta;
      weakestPrecision = precision;
    }
  }
  return { thetaHat: weakestTheta, thetaPrecision: weakestPrecision };
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

/**
 * 收集一条题候选的信号。
 */
async function collectQuestionSignal(db: DbLike, cand: CandidateInput): Promise<CollectedSignal> {
  const knowledgeIds = cand.knowledgeIds ?? [];
  const { thetaHat, thetaPrecision } = await aggregateWeakestKc(db, knowledgeIds);
  const { b, bSource } = await resolveBAnchor(db, cand.refId, cand.difficulty);

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

  // MFI 评分快照：复用 core 数学（mfiScore/diagnosticScore，selection-signals.ts），不在此
  // 重算。recall-locked 或缺 θ̂/b 时不算（留 undefined）。
  let mfi: number | undefined;
  let diag: number | undefined;
  if (!recallLocked && thetaHat !== undefined && b !== undefined) {
    mfi = mfiScore(thetaHat, b);
    if (thetaPrecision !== undefined) {
      diag = diagnosticScore(thetaHat, b, thetaPrecision);
    }
  }

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
    // ─────────────────────────────────────────────────────────────────────────
    // §9.2 / ADR-0042 编排档2 first-class 信号扩充（选题不止 MFI 中心）。
    // 调查结论（2026-06-16，Step A）：三者**当前都无 cheap reader**，全留 undefined
    // （NEVER zero-fill——undefined = 「无数据」，0 = 「测得为零」，评分层据此 MFI-only 退化）。
    //   - examRelevance（考纲/考点权重）：SubjectProfileSchema（profile-schema.ts）无
    //     examWeight/syllabus 字段；无考纲映射数据源。Phase 3+ 若引入 subject profile
    //     考纲权重表，在此据 candidate 的 knowledgeIds → 考点权重映射计算。
    //   - misconceptionRecurrence（错误观念复发度）：mistake_variant 表有 cause_category
    //     + parent_question_id，但「候选题 → 错因家族跨 attempt 复发频次」需新建聚合查询
    //     （非 trivial read，超出 Step A 的 scope discipline）。Phase 3+ 据错题家族
    //     （cause_category 维）的复发频次计算。
    //   - transferGap（迁移缺口）：mastery_state 按 (subject_kind, subject_id) 即 per-KC
    //     建键，**无 kind 维度**——同 KC 跨题型掌握差无法从现表 cheap 读出。Phase 3+ 需
    //     先有 per-(KC,kind) 粒度的掌握度（或 Task 10 family-level calibration）才能算。
    // 不为这三个新信号自建子系统/查询（impl plan §「Map 阶段」+ roadmap Task 7 Step 4
    // 「缺数据留 undefined」+ scope discipline）。
    // ─────────────────────────────────────────────────────────────────────────
    examRelevance: undefined,
    misconceptionRecurrence: undefined,
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
  const out: CollectedSignal[] = [];
  for (const cand of candidates) {
    if (cand.refKind === 'paper') {
      out.push(collectPaperSignal(cand));
    } else {
      out.push(await collectQuestionSignal(db, cand));
    }
  }
  return out;
}

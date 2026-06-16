// YUK-361 Phase 5 (ADR-0043 §家族级 b_personalized) — 家族级 b 个性化校准机器。
//
// ─── 为什么是「家族」而非逐题 ──────────────────────────────────────────────
// ADR-0043 的诚实天花板：单题 b_j 在 n=1 下结构性不可精确定（logit 平移不变
// `θ→θ+c, b→b+c` 似然不变；N=1 校准样本，PPI 单题退回 fixed-anchor 反推 CI 宽）。
// 但同一 `(subject, primaryKnowledge, kind, source)` 家族的多道题共享一个系统性
// 难度偏移信号——攒够重复的**客观**观测后，家族级 b_delta 是可估的（每道题只贡献
// 一两条观测，但家族聚合到 n≥20 后，shrinkage 守保守即可给出一个低 MSE 的偏移估计）。
// 这是「逐题 b_j 单点 n=1 无法精确定」的家族级绕道（ADR-0043 Phase 5 amendment）。
//
// ─── 不变量①（红线）──────────────────────────────────────────────────────
// 本模块**永不**写 item_calibration.b（那是 item-半边锁死 G4 的外部锚，永不被在线
// 回路回写）。家族 b_delta 是一个**独立的调整层**，只在读侧用 effectiveFamilyB 组合：
//   b_effective = b_anchor + shrunk_b_delta
// 锚本身不被污染——这是与 θ̂ 在线更新（state.ts，碰 mastery_state）正交的第二条慢线。
//
// ─── 两时间尺度（ADR-0043 §识别性靠两时间尺度随机逼近）────────────────────
// θ̂ 是**快尺度**（每作答 Elo，视 b 为固定常数，state.ts）；家族 b_delta 是**慢尺度**
// （攒够客观观测才动，门控 n≥20 + ≥5 distinct questions）。硬条件「b 校准频率 ≪ θ
// 更新频率」在此体现：θ̂ 每次作答都动，b_delta 只在家族慢热攒够后才离 0。这是 n=1
// 尺度分离的结构性切分（b 的信息源完全在单人在线回路之外的对偶——这里是「同一家族
// 重复客观观测的系统性偏移」，不是单次作答的 θ 漂移）。
//
// ─── 消费接缝（本 Phase 不翻 live selection）──────────────────────────────
// effectiveFamilyB 已 export + 单测，但本 Phase **不**把它接进 live 选题的 b-resolution
// （candidate-signals b-resolution + θ̂ 锚组合）。Phase 6（Task 11）会引入
// `b_anchor`/`b_calib` 列，届时 live b-resolution 的终态组合是：
//   b_effective = (b_calib ?? b_anchor ?? b)  THEN  + effectiveFamilyB 的 family_delta
// 把家族 delta 接进 live b-resolution 是一个 thin follow-up（见本模块 effectiveFamilyB
// 文档 + roadmap Task 10 step 5）。本 Phase 只 build + store + expose + test 机器。

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import { newId } from '@/core/ids';
import { DIFFICULTY_PROXY_WEIGHT, difficultyToLogitB, expectedScore } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { item_calibration, item_family_calibration, mastery_state, question } from '@/db/schema';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { and, count, eq, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

// ─────────────────────────────────────────────────────────────────────────────
// 门控阈值（ADR-0043 「shrinkage 守保守」+ Phase 5 step 4）。
//   - FAMILY_MIN_EVIDENCE：家族级 n 下限——攒够这么多客观观测才让 b_delta 离 0。
//   - FAMILY_MIN_DISTINCT_QUESTIONS：家族至少要有这么多**不同**题贡献观测，防止
//     一道题被反复刷成「家族信号」（单题 n 多≠家族 b 偏移；家族绕道的合法性依赖
//     跨题的系统性，不是单题的重复）。
//   - SHRINKAGE_PRIOR_STRENGTH：经验贝叶斯收缩的先验强度（priorStrength），n 等于
//     它时收缩因子 = 0.5。
// 阈值是占位裁决（owner 可调）——门控未过时只累 evidence_count，b_delta 恒 0。
// ─────────────────────────────────────────────────────────────────────────────
export const FAMILY_MIN_EVIDENCE = 20;
export const FAMILY_MIN_DISTINCT_QUESTIONS = 5;
export const SHRINKAGE_PRIOR_STRENGTH = 20;

// ─────────────────────────────────────────────────────────────────────────────
// 客观判分路由白名单（ADR-0043 §6「PPI 真值目标量 = 难度 b，不是判分」+ Phase 5
// step 4「objective/graded outcome exists, not a soft/subjective judge」）。
//
// 只有**确定性、无 LLM、无主观裁量**的判分路由产出的 outcome 才喂家族校准——它们
// 的 0/1 是「答案对/错」的客观事实，不混 LLM 主观判断的噪声。LLM-backed 路由
// （semantic/rubric/steps/multimodal_direct/ai_flexible）的 verdict 带主观性，
// 把它当 b 真值会把 LLM 评分偏差混进 b。
//
//   - exact / keyword：纯字符串/集合匹配，零 LLM，确定性 → 客观。
//   - unit_dimension：**有意排除**——它有确定性 accelerator，但带 LLM fallback
//     （llm-fallback.ts），混合路由不算纯客观；保守起见不喂（宁缺毋滥，与 ADR-0043
//     的保守姿态一致）。若未来证 accelerator 命中率足够高可单列，本 wave 不冒险。
//
// ⚠️ 即便路由客观，单次作答的 outcome 仍混 θ/learning 漂移（ADR-0043 §6 警告）。
// 家族级聚合 + shrinkage + n≥20 门控正是为了把单次噪声平均掉、只留家族系统性偏移；
// 这不是把单答即写成 b（那正是 §6 要避免的），而是慢热攒够后的家族残差均值。
// ─────────────────────────────────────────────────────────────────────────────
export const OBJECTIVE_JUDGE_ROUTES: ReadonlySet<string> = new Set<string>(['exact', 'keyword']);

/** 该判分路由是否客观（确定性、无 LLM）——家族校准的硬门之一。 */
export function isObjectiveJudgeRoute(route: string | null | undefined): boolean {
  return route != null && OBJECTIVE_JUDGE_ROUTES.has(route);
}

// ─────────────────────────────────────────────────────────────────────────────
// family_key 组装（Phase 5 step 2）。`${subject}:${primaryKnowledgeId}:${kind}:${source}`。
//
//   - subject：primary knowledge 的 effective_domain → subject id（DERIVED 轴，
//     非存储列——subject 是视角不是结构，见 resolveFamilyKeyForQuestion 文档）。
//   - primaryKnowledgeId：题目的**首个/主** knowledge_id（q.knowledge_ids[0]）。
//   - kind：question.kind（题型）。
//   - source：question.source（来源）。
//
// 绝不含 exact question id——家族绕道的核心是「多题共享一个 b_delta」。
// ─────────────────────────────────────────────────────────────────────────────
export function familyKey(
  subject: string,
  primaryKnowledgeId: string,
  kind: string,
  source: string,
): string {
  return `${subject}:${primaryKnowledgeId}:${kind}:${source}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shrinkage（经验贝叶斯收缩，Phase 5 step 3）。
//
//   shrunk = (n / (n + priorStrength)) · rawDelta
//
// 纯函数。收缩因子 n/(n+priorStrength) 随 n 单调升：
//   - n = 0          → 0          （无证据，完全收缩到先验 0）
//   - n = priorStrength → 0.5·raw （证据等于先验强度，半信半疑）
//   - n → ∞          → rawDelta   （证据压倒先验，趋向裸估计）
// 这是 ADR-0043 §shrinkage（经验贝叶斯，有偏低 MSE）的逐家族先验结构层——把噪声大
// 的家族 raw_delta 向 0 拉，攒够样本才放行，守「shrinkage 守保守」。
// ─────────────────────────────────────────────────────────────────────────────
export function shrinkFamilyDelta(
  rawDelta: number,
  n: number,
  priorStrength = SHRINKAGE_PRIOR_STRENGTH,
): number {
  if (n <= 0) return 0;
  return (n / (n + priorStrength)) * rawDelta;
}

/** 收缩因子本身（= confidence），暴露给 update 写 confidence 列。 */
export function shrinkageFactor(n: number, priorStrength = SHRINKAGE_PRIOR_STRENGTH): number {
  if (n <= 0) return 0;
  return n / (n + priorStrength);
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw-delta ESTIMATOR — 家族级难度残差均值（ADR-0043 §两时间尺度 + §6）。
//
// Task 10 没完全 specify raw-delta 公式，这里实现一个有据可依的：
//
// 直觉：对一道客观题，给定学习者当前能力 θ̂ 和题的锚难度 b_anchor，1PL/Rasch 模型
// 预测答对概率 p = σ(θ̂ − b_anchor)。一次作答的 outcome ∈ {0,1} 与 p 的偏离（残差
// outcome − p）携带「这道题对这个学习者比锚预测的更难还是更容易」的信号：
//   - outcome < p（预测会对却答错）→ 题比锚显得更难 → b 应上调（正残差→正 delta）。
//   - outcome > p（预测会错却答对）→ 题比锚显得更容易 → b 应下调。
//
// 在 logit 尺度上，把这个残差转成难度偏移：单次观测的「隐含难度偏移」
//   residual_logit = −(outcome − p) / (p·(1−p) + eps)
// 是 1PL 对数似然对 b 的（牛顿式）梯度方向归一化——p·(1−p) 是 b 的 Fisher 信息，
// 除它把残差换算到 logit 尺度的有效步长（与 state.ts 的 fisherInformation 同源）。
// 符号：对 b 求导，∂/∂b log P = −(outcome − p)，故难度偏移正比于 −(outcome − p)；
// 答错（outcome=0, residual=p）→ 正偏移（更难），与直觉一致。
//
// 家族 raw_delta = 这些 residual_logit 的**运行均值**（家族内所有客观观测）——
// 即「观测到的、对这个学习者而言的难度」与「锚 b」之间的系统性 offset 的均值估计。
// 多次观测的随机噪声（θ 漂移、运气）被均值平掉，只留家族系统性偏移。这正是
// ADR-0043 §两时间尺度里 b 慢半边的离线/批量去偏在「家族级」的轻量实例化：θ̂ 快
// （每答即动），家族 b_delta 慢（攒均值，门控放行）。
//
// 数值守护：Fisher 信息 p·(1−p) 在 p→0/1 时趋 0（题太难/太易，单次观测对 b 几乎
// 无信息），裸除会爆——故 (a) 分母 floor MIN_FISHER，(b) 每次 residual_logit 量级
// clamp 到 MAX_RESIDUAL_LOGIT（一次极端 surprise 不该独占家族均值）。保守 clamp。
//
// 实现为「运行均值」增量更新：newMean = oldMean + (residual − oldMean)/foldedN，
// 数值稳定且 O(1) 状态。b_delta 存的是**收缩后**的值，故 update 路径需反推旧 raw mean：
//   newRawMean = oldRawMean + (residual − oldRawMean)/calibrated_n
// 我们不单独持久化 rawMean，而是每次 update 时**重算**需要 oldRawMean——为此
// updateFamilyCalibration 持久化的 b_delta 是**收缩值**，oldRawMean 由调用方在 tx 内
// 从「当前 row 的收缩值 ÷ shrinkageFactor(calibrated_n)」反推（因子在 n>0 时非零，安全）。
//
// ⚠️ 反推用的有效样本量基是 **calibrated_n**（持久化列，只数实际折进 running mean 的残差
// 条数），**不是** evidence_count 也不是 n − FAMILY_MIN_EVIDENCE + 1（finding #2 修复）。
// 后两者在 distinct 门「晚跨」（n 在 distinct≥5 之前就 ≥20）时会把「门未全过期间从未折进
// mean 的观测」错当成已折进样本，注入 phantom mean-0 把 b_delta 永久稀释。calibrated_n 只
// 在两门**都**过时才 +1、门未全过期间恒 0，故不变量
//   storedDelta = shrinkFamilyDelta(runningMeanOf(实际折进的 residuals), calibrated_n)
// **与门跨越顺序无关**地精确成立。见 updateFamilyCalibration 实现注释。
// ─────────────────────────────────────────────────────────────────────────────
const MIN_FISHER = 0.05; // p·(1−p) 下限（p≈0.05 或 0.95 处），防 logit 步长爆。
const MAX_RESIDUAL_LOGIT = 2.0; // 单次隐含难度偏移量级 clamp（logit），保守。

/**
 * 单次客观观测的「隐含难度偏移」（logit 尺度）。
 * residual_logit = −(outcome − p) / max(p·(1−p), MIN_FISHER)，clamp ±MAX_RESIDUAL_LOGIT。
 * outcome=0（答错）→ 正（题更难）；outcome=1（答对）→ 负（题更易）。
 */
export function impliedDifficultyResidual(theta: number, bAnchor: number, outcome: 0 | 1): number {
  const p = expectedScore(theta, bAnchor); // σ(θ − b_anchor)
  const fisher = Math.max(p * (1 - p), MIN_FISHER);
  const raw = -(outcome - p) / fisher;
  return Math.max(-MAX_RESIDUAL_LOGIT, Math.min(MAX_RESIDUAL_LOGIT, raw));
}

// ─────────────────────────────────────────────────────────────────────────────
// Read helper — effectiveFamilyB（Phase 5 step 5）。
//
// b_effective_family = b_anchor + family_row.b_delta
// （b_delta 已是**收缩后**的存储值——门控未过时它恒 0，故未达阈值的家族不改 b）。
//
// 消费接缝（本 Phase 不翻 live selection，见模块顶 doc）：Phase 6（Task 11）引入
// b_anchor/b_calib 后，live b-resolution 终态是
//   b_effective = (b_calib ?? b_anchor ?? b)  THEN  effectiveFamilyB(那个, familyRow)
// 即家族 delta 叠在 Phase 6 的去偏 b 之上。本函数已可独立组合，接进 candidate-signals
// 的 b-resolution + θ̂ 锚是 thin follow-up（不在本 Phase 翻）。
// ─────────────────────────────────────────────────────────────────────────────
export interface FamilyCalibrationRow {
  family_key: string;
  b_delta: number;
  evidence_count: number;
  confidence: number;
  /**
   * 真正折进 b_delta running mean 的残差条数（两门都过起算）。门控未过期间为 0。
   * 与 evidence_count 区分：见 schema.ts item_family_calibration.calibrated_n 注释。
   * finding #2 修复——running-mean 反推/前进的有效样本量基（避免 distinct 门晚跨时
   * 用 evidence_count 当基注入 phantom mean-0 样本稀释 b_delta）。
   */
  calibrated_n: number;
}

/**
 * 家族调整后的有效 b。familyRow 为 null（无该家族行）→ 原样返回 b_anchor。
 * b_delta 已是收缩值（门控未过 → 0），故安全直加。
 */
export function effectiveFamilyB(bAnchor: number, familyRow: FamilyCalibrationRow | null): number {
  if (familyRow === null) return bAnchor;
  return bAnchor + familyRow.b_delta;
}

/** 读单家族的校准行，或 null（冷启）。 */
export async function getFamilyCalibration(
  db: DbLike,
  key: string,
): Promise<FamilyCalibrationRow | null> {
  const rows = await db
    .select({
      family_key: item_family_calibration.family_key,
      b_delta: item_family_calibration.b_delta,
      evidence_count: item_family_calibration.evidence_count,
      confidence: item_family_calibration.confidence,
      calibrated_n: item_family_calibration.calibrated_n,
    })
    .from(item_family_calibration)
    .where(eq(item_family_calibration.family_key, key))
    .limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update path + gates（Phase 5 step 4）。
//
// updateFamilyCalibration 在一次**客观判分** attempt 的结果上累积该家族证据并重算
// b_delta（raw → shrunk）——但只在**全部门控**通过时才把 b_delta 写离 0：
//   (a) 客观/graded outcome 存在（isObjective=true，非 soft/subjective judge）；
//   (b) 该家族 n ≥ FAMILY_MIN_EVIDENCE；
//   (c) 该家族 ≥ FAMILY_MIN_DISTINCT_QUESTIONS distinct questions。
// 门控未过：累 evidence_count（+ 维护运行 raw mean，但收缩后写 0），b_delta 保持 0。
//
// distinct-questions 门：本 wave 用一个轻量 PG 侧实现——distinct question 计数靠
// 一个并行的 evidence_count 不够（它只数观测条数）。为不引入第二张表，我们让调用方
// 传入「该家族当前已见过的 distinct question 数（含本题，若本题是新题）」由热路径
// 旁路查询给出（见 hook 调用注释）。这避免本表存 question id 集合（违反「不含 exact
// question id」的家族绕道精神，且会让表无限膨胀）。
//
// 同 tx vs best-effort：本函数被设计为 attempt tx 内 best-effort 调用——它**绝不**
// 抛错冒泡打断 attempt 写（θ̂/FSRS/event 是主路径，家族校准是慢热增益层，丢一两条
// 观测不影响正确性，下次自愈）。调用方用 try/catch 包裹（见 hook 注释）。它接受 Tx
// 以参与同一事务（计数一致），但失败被吞。
// ─────────────────────────────────────────────────────────────────────────────
export interface UpdateFamilyCalibrationInput {
  /** familyKey(...) 的结果。 */
  familyKey: string;
  /** 学习者作答时的 θ̂（快尺度锚，与 raw-delta 估计同步——ADR-0043 两时间尺度）。 */
  theta: number;
  /** 题的锚难度 b（item_calibration.b 或弱锚 difficultyToLogitB）。 */
  bAnchor: number;
  /** 客观判分结果：success=1 / failure=0。 */
  outcome: 0 | 1;
  /** 该判分是否客观（isObjectiveJudgeRoute 的结果）——门 (a)。 */
  isObjective: boolean;
  /**
   * 该家族（含本题）当前的 distinct question 数——门 (c)。由热路径旁路查询给出
   * （见 hook 注释）。本表不存 question id 集合（家族绕道精神 + 防膨胀）。
   */
  distinctQuestionCount: number;
  /**
   * 锚权重（弱锚降权）——difficulty_proxy 弱锚时 = DIFFICULTY_PROXY_WEIGHT (0.3)，
   * item_calibration.b 真锚时 = 1。本次观测的隐含难度残差按它缩放，与 θ̂ 更新的
   * bWeight 语义一致（弱锚提供的信息打折，不让占位锚主导家族 b 偏移）。默认 1。
   */
  anchorWeight?: number;
  now: Date;
}

export async function updateFamilyCalibration(
  tx: Tx,
  input: UpdateFamilyCalibrationInput,
): Promise<void> {
  // 门 (a)：非客观判分（soft/subjective judge）直接不更新——一条都不累。
  // 软判分的 outcome 带 LLM 主观噪声，不该进 b 真值通道（ADR-0043 §6）。
  if (!input.isObjective) return;

  // 串行化该家族的 read-modify-write（同 mastery_state 的 per-KC 锁模式）。家族 key
  // 命名空间独立，攒够后并发作答不丢增量。tx commit 时释放。
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`family_calibration:${input.familyKey}`}))`,
  );

  const existing = await getFamilyCalibration(tx, input.familyKey);
  const oldN = existing?.evidence_count ?? 0;
  const newN = oldN + 1;
  // 真正折进 running mean 的旧 fold 计数（两门都过起算）。门控未过期间存的是 0。
  const oldCalibratedN = existing?.calibrated_n ?? 0;

  // ── 运行均值的「有效样本量」与门控起点（finding #2 修复）──────────────────
  // 裁决（保守 + honest）：把**两门 FIRST 都满足**的那一刻视为家族校准的起点，而非
  // 仅 n 门跨阈值的那一刻。旧实现用 effectiveN = n − FAMILY_MIN_EVIDENCE + 1（即把 n
  // 门跨阈值当起点）——但当 distinct 门**晚于** n 门满足时（n 在 distinct≥5 之前就 ≥20），
  // n 门跨阈值后、distinct 门未过的那些观测**从未折进** b_delta（b_delta 恒 0），却被
  // effectiveN 当成已折进的样本计入，反推 oldRawMean = 0/shrinkage(>1) = 0 注入 phantom
  // mean-0 样本，永久把 b_delta 向 0 稀释（all-+2 residual、distinct 在 n=26 才翻 ok →
  // 错得 0.32 vs 正确 0.71）。
  //
  // 修复：用持久化的 calibrated_n（只数实际折进 mean 的残差条数）当运行均值的有效样本量
  // 基，**与门跨越顺序无关**。不变量：
  //   storedDelta(上一次) = oldRawMean · shrinkageFactor(oldCalibratedN)
  //   ⟹ oldRawMean = storedDelta / shrinkageFactor(oldCalibratedN)   （因子在 n>0 非零）
  // 反推用与写入**同一个 calibrated_n 基**，round-trip 精确。门控未过期间 calibrated_n=0、
  // b_delta=0，故两门**首次**都过时 newCalibratedN = 1、newRawMean = residual（不掺任何
  // 预热期的 phantom 样本，无论 distinct 门何时跨）。
  const distinctOk = input.distinctQuestionCount >= FAMILY_MIN_DISTINCT_QUESTIONS;
  const gatesPassedNow = newN >= FAMILY_MIN_EVIDENCE && distinctOk;
  // 上次是否已折进过（两门都过过 → calibrated_n>0）。注意：不用 oldN≥阈值 && distinctOk
  // 判断，因为 distinctQuestionCount 是当前传入值，可能这次才首次过 distinct 门——折进
  // 与否的真相是「上次有没有真折进」，即 oldCalibratedN>0。
  const foldedBefore = oldCalibratedN > 0;

  const oldRawMean =
    foldedBefore && existing != null ? existing.b_delta / shrinkageFactor(oldCalibratedN) : 0;

  // 本次客观观测的隐含难度偏移（logit），按锚权重缩放（弱锚降权）。
  const anchorWeight = input.anchorWeight ?? 1;
  const residual =
    anchorWeight * impliedDifficultyResidual(input.theta, input.bAnchor, input.outcome);

  let storedDelta = 0;
  let storedConfidence = 0;
  let newCalibratedN = oldCalibratedN; // 门控未过时保持原 fold 计数（恒 0）。
  if (gatesPassedNow) {
    // 折进计数 +1。两门首次都过（foldedBefore=false）→ 从 1 起算。
    newCalibratedN = foldedBefore ? oldCalibratedN + 1 : 1;
    // 运行均值增量更新。两门首次都过（foldedBefore=false）→ newRawMean = residual。
    const newRawMean = foldedBefore
      ? oldRawMean + (residual - oldRawMean) / newCalibratedN
      : residual;
    // confidence = 收缩因子；b_delta = 收缩后的家族偏移。用同一 calibrated_n 基，
    // 保证下一次 update 的反推 round-trip 精确。
    storedConfidence = shrinkageFactor(newCalibratedN);
    storedDelta = shrinkFamilyDelta(newRawMean, newCalibratedN);
  }
  // 门控未过：storedDelta/storedConfidence 保持 0、calibrated_n 不动（只累 evidence_count）。

  await tx
    .insert(item_family_calibration)
    .values({
      id: newId(),
      family_key: input.familyKey,
      b_delta: storedDelta,
      evidence_count: newN,
      confidence: storedConfidence,
      calibrated_n: newCalibratedN,
      updated_at: input.now,
    })
    .onConflictDoUpdate({
      target: item_family_calibration.family_key,
      set: {
        b_delta: storedDelta,
        evidence_count: newN,
        confidence: storedConfidence,
        calibrated_n: newCalibratedN,
        updated_at: input.now,
      },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook 编排 — recordFamilyObservationForAttempt（attempt tx 内 best-effort 调用）。
//
// 给一道客观判分的 attempt，解析 family_key 所需的全部派生量并调 updateFamilyCalibration：
//   - subject：getEffectiveDomain(primaryKnowledgeId) → resolveKnownSubjectId（DERIVED
//     轴，subject 是视角不是结构）。未知/orphan domain → 'unknown' 段（不塌进 default
//     'wenyan'，防 YUK-288 式过匹配把不同科目刷成同家族）。
//   - bAnchor：item_calibration.b（track='hard'）有则用，否则弱锚 difficultyToLogitB
//     （与 state.ts θ̂ 更新读的同一锚链，两条慢线对齐同一 b 来源）。
//   - theta：primary knowledge 的 mastery_state.theta_hat（快尺度，冷启 0）。
//   - distinctQuestionCount：该家族的题面广度——见 countDistinctQuestionsInFamily。
//
// 同 tx vs best-effort 裁决（DOCUMENTED）：在 attempt tx 内调用以保证计数与作答一致
// （否则两次作答可能读到同一旧计数 race），但**整个调用被 hook 的 try/catch 吞掉**
// ——家族校准是慢热增益层，丢一两条观测不影响 attempt 正确性，下次作答自愈。本函数
// 内部不再 try/catch（让 hook 决定吞），但被设计为可被吞而不留半写（单条 upsert，
// 无跨步副作用）。绝不让它 fail attempt 的 θ̂/FSRS/event 主路径。
// ─────────────────────────────────────────────────────────────────────────────
export interface RecordFamilyObservationInput {
  /** 题的 primary knowledge（q.knowledge_ids[0]）。无则跳过（家族无法成键）。 */
  primaryKnowledgeId: string | null | undefined;
  /** question.id —— 仅用于读锚 b + distinct 计数，不进 family_key。 */
  questionId: string;
  /** question.kind。 */
  kind: string;
  /** question.source。 */
  source: string;
  /** question.difficulty（弱锚兜底用）。 */
  difficulty: number;
  /** 客观判分结果：success=1 / failure=0。 */
  outcome: 0 | 1;
  /** 判分路由（isObjectiveJudgeRoute 判客观性）。null → 视为非客观，跳过。 */
  judgeRoute: string | null | undefined;
  now: Date;
}

/**
 * 计该家族的 distinct question 数（门 c 的输入）。家族 = 同 primary knowledge + kind
 * + source 的题集（subject 由 primary knowledge 派生，已被 primaryKnowledge 蕴含）。
 * 用 `knowledge_ids->>0` 取 jsonb 首元素当 primary。这是题面广度 proxy——家族绕道的
 * 合法性依赖跨题系统性（≥5 道不同题），不是单题重复。
 */
export async function countDistinctQuestionsInFamily(
  db: DbLike,
  primaryKnowledgeId: string,
  kind: string,
  source: string,
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(question)
    .where(
      and(
        sql`${question.knowledge_ids}->>0 = ${primaryKnowledgeId}`,
        eq(question.kind, kind),
        eq(question.source, source),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function recordFamilyObservationForAttempt(
  tx: Tx,
  input: RecordFamilyObservationInput,
): Promise<void> {
  const primaryKnowledgeId = input.primaryKnowledgeId?.trim();
  if (!primaryKnowledgeId) return; // 无 primary knowledge → 家族无法成键，跳过。

  // 门 (a) 早返：非客观判分不触任何 DB。
  if (!isObjectiveJudgeRoute(input.judgeRoute)) return;

  // subject 派生（DERIVED 轴）。getEffectiveDomain 可能因 orphan id 抛错——容错为
  // 'unknown' 段（不塌进 default profile，防过匹配）。
  let subject = 'unknown';
  try {
    const domain = await getEffectiveDomain(tx, primaryKnowledgeId);
    subject = resolveKnownSubjectId(domain) ?? 'unknown';
  } catch {
    subject = 'unknown';
  }

  const key = familyKey(subject, primaryKnowledgeId, input.kind, input.source);

  // b 锚：与 state.ts θ̂ 更新同一来源链（item_calibration.b track='hard' → 弱锚兜底）。
  const calRows = await tx
    .select({ b: item_calibration.b })
    .from(item_calibration)
    .where(
      and(eq(item_calibration.question_id, input.questionId), eq(item_calibration.track, 'hard')),
    )
    .limit(1);
  const calB = calRows[0]?.b ?? null;
  const bAnchor = calB ?? difficultyToLogitB(input.difficulty);
  // 弱锚降权：difficulty_proxy 锚的隐含残差用 DIFFICULTY_PROXY_WEIGHT 缩放，与 θ̂
  // 更新的 bWeight 语义一致（弱锚提供的信息打折，不让占位锚主导家族 b 偏移）。
  const anchorWeight = calB !== null ? 1 : DIFFICULTY_PROXY_WEIGHT;

  // θ̂：primary knowledge 当前能力估计（快尺度），冷启 0。
  const stateRows = await tx
    .select({ theta_hat: mastery_state.theta_hat })
    .from(mastery_state)
    .where(
      and(
        eq(mastery_state.subject_kind, 'knowledge'),
        eq(mastery_state.subject_id, primaryKnowledgeId),
      ),
    )
    .limit(1);
  const theta = stateRows[0]?.theta_hat ?? 0;

  const distinctQuestionCount = await countDistinctQuestionsInFamily(
    tx,
    primaryKnowledgeId,
    input.kind,
    input.source,
  );

  await updateFamilyCalibration(tx, {
    familyKey: key,
    theta,
    bAnchor,
    outcome: input.outcome,
    isObjective: true, // 已过 isObjectiveJudgeRoute 早返。
    distinctQuestionCount,
    anchorWeight, // 弱锚降权（calB===null → 0.3，与 θ̂ 更新的 bWeight 对齐）。
    now: input.now,
  });
}

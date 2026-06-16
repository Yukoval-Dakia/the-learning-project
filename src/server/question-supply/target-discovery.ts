// YUK-361 Phase 8 (Task 13) — 题目供给目标发现引擎（确定性缺口扫描器）。
//
// 权威 spec：
//   - docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md Task 13 Step 1-2
//   - docs/design/2026-06-15-question-supply-target-discovery-architecture.md（供给侧镜像）
//
// 选题 vs 供给的镜像分工（架构 doc §Executive Summary）：
//   - 选题引擎：从现有 active 池里挑「现在练什么」。
//   - 供给目标发现引擎：决定「池缺什么、为什么重要、该走哪条获取线去补」。
//
// 本模块是供给侧的**确定性 + 只读 + 即刻生效**层：扫当前池 → 产出获取目标（QuestionSupplyTarget）。
// **不调 LLM、不插题、不晋升 draft、不决定今日练题顺序**（架构 doc §Services 的 must-not 清单）。
// 派发到既有获取面是 dispatcher.ts 的活（thin IO 层）。
//
// 设计：纯扫描器（scanCoverageGaps）吃**已加载好的输入**（可测、无 IO），IO 加载器
// （discoverSupplyTargets）读 DB 复用既有 reader 后喂纯扫描器。这样规则全部在纯函数里可测，
// DB 测试只验「真实 DB 行 → 加载成正确输入 → 目标」的端到端。
//
// 数据源（全部复用既有 reader，零新查询子系统）：
//   - 活跃目标 + learning_item.knowledge_ids：listActiveLearningItemKnowledge（mirror stream-store.ts:137-141）
//   - 前沿/新检知识点：active learning item 的 KC 里**没有 material_fsrs_state 行**者
//     （= 从未被调度 = 新知/前沿，mirror stream-store.ts:144-156「新学待检」语义）。
//   - mastery_state.theta_hat/theta_precision：getMasteryState（src/server/mastery/state.ts）。
//   - 现有题按 knowledge_id + kind + difficulty band + source tier 分组：本模块的 loadQuestionPool。
//   - source tier：deriveSourceTier（src/core/schema/provenance.ts，4 档 provenance）→
//     映射成本引擎的 3 档获取尺度（见 acquisitionTierForQuestion 文档）。
//   - subject profile sourcingRoutePreference：subjectProfiles（src/subjects/profile.ts）。

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import { rotationClassForKind } from '@/capabilities/practice/server/variant-rotation';
import type { QuestionKindT } from '@/core/schema/judge-routing';
import { deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { item_calibration, learning_item, question } from '@/db/schema';
import { effectiveB } from '@/server/mastery/recalibration';
import { getMasteryState } from '@/server/mastery/state';
import { resolveSubjectProfile, subjectProfiles } from '@/subjects/profile';
import type { SubjectProfile } from '@/subjects/profile-schema';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

// ── Types（Task 13 Step 1，prompt 字面给定的形状即权威）────────────────────────

export type SupplyRoute =
  | 'author_question'
  | 'sourcing_web'
  | 'ingest_existing'
  | 'image_candidate'
  | 'quiz_gen';

export type DifficultyBand = 'below' | 'near' | 'above' | 'stretch';

/**
 * 一个供给目标 = 多维池里的一个待补的格子（不是「写一道题」，是「这个 KC×题型×难度档×
 * source-tier 的格子缺了，去补」）。`minSourceTier` 是本引擎的**获取尺度** 1|2|3（不是
 * provenance 的 4 档）：1=要高可信（真题/人工/录入），2=要中可信以上（web 既存题或更高），
 * 3=生成级即可（拟题/草稿即可填）。`kind` 是题型字符串（QuestionKind 词表之一或 'any'）。
 */
export interface QuestionSupplyTarget {
  id: string;
  /** 稳定指纹（subjectId+knowledgeIds+kind+difficultyBand+gapKind+minSourceTier）。重复扫描更新同一目标而非洪泛。 */
  fingerprint: string;
  /** 缺口类别（reason 的机器可读形态，用于派发/观测分流）。 */
  gapKind: SupplyGapKind;
  subjectId: string;
  knowledgeIds: string[];
  kind: string;
  difficultyBand: DifficultyBand;
  desiredCount: number;
  minSourceTier: 1 | 2 | 3;
  routePreference: SupplyRoute[];
  /**
   * review FINDING #3：当 routePreference 把 `quiz_gen` 列入时，区分它来自 `material` token
   * （material_grounded：拉真原文 grounding）还是 `closed_book` token（闭卷生成）。dispatcher 把
   * quiz_gen job 的 generation_method 设成本值（缺省时退回 minSourceTier 推导，见 dispatcher
   * generationMethodFor）。`material` 与 `closed_book` 都映射成 quiz_gen 队列，但生成方法不同——
   * 不保留这层区分会丢掉 quiz_gen handler honor 的 material_grounded vs closed_book。
   */
  preferredGenerationMethod?: 'material_grounded' | 'closed_book';
  priority: number;
  reason: string;
  constraints: {
    needsImage?: boolean;
    objectiveOnly?: boolean;
    calibrationCandidate?: boolean;
    avoidDuplicateOfQuestionIds?: string[];
  };
}

export type SupplyGapKind = 'frontier_zero' | 'source_quality' | 'diagnostic' | 'format_diversity';

// ── 纯扫描器输入（IO 加载器加载好后喂进来）─────────────────────────────────────

/** 一道现有题的最小投影（够算 source tier + difficulty band + kind 归类）。 */
export interface PoolQuestion {
  id: string;
  kind: QuestionKindT;
  /** question.source 列（provenance 推导用）。 */
  source: string;
  /** question.metadata（provenance 推导用，可空）。 */
  metadata: Record<string, unknown> | null;
  /** 1-5 难度档（difficulty band 归类的兜底来源）。 */
  difficulty: number;
  /**
   * effectiveB = b_calib ?? b_anchor ?? b（review FINDING #4）。有 item_calibration 行（任一
   * b 列非空）→ 一个**可靠锚**（mastery/selection 用的同一 b 解析，src/server/mastery/recalibration
   * effectiveB），band 归类优先用它。null = 无 item_calibration 行（纯 difficulty proxy，非可靠锚）。
   * 关键：b_anchor/b 是 ItemPriorTask 写的冷启锚（real anchor），**不是** difficultyToLogitB
   * 弱 proxy——effectiveB 退回 b_anchor ?? b 仍是可靠锚，故 R3「只信真实标定」与本字段不冲突。
   */
  calibrationB: number | null;
  /** 该题挂的全部 KC。 */
  knowledgeIds: string[];
}

/**
 * 一个 active-goal KC 的扫描输入（review FINDING #6：不再限「前沿/未入册」，覆盖全部 active-goal
 * KC，含已入册但 thin 者）。命名保留 `Frontier` 是历史包袱（最初只扫前沿）；语义现在是「待扫的
 * active-goal KC」。frontier/coverage 缺口由扫描器据可用题数 < 阈值判定，不靠 FSRS 入册态。
 */
export interface FrontierKnowledgeInput {
  knowledgeId: string;
  subjectId: string;
  /** mastery_state.theta_hat；冷启（无行）兜底 0（logit 原点）。 */
  thetaHat: number;
  /** mastery_state.theta_precision；冷启兜底 1（弱先验 SE=1）。 */
  thetaPrecision: number;
  /** mastery_state.evidence_count；冷启 0。新知 scaffold vs 诊断分流用。 */
  evidenceCount: number;
}

export interface ScanInput {
  frontier: FrontierKnowledgeInput[];
  /**
   * 现有**可用**题池（review FINDING #1：已在 loadQuestionPool 过滤掉 draft_status='draft'）。
   * 只有 non-draft / 已晋升题算真覆盖——一个 KC 唯一的题若是被拒/未验证草稿，不该被当作已覆盖
   * 而压制 R1/R2（草稿不是可用 item）。本扫描器再据 source tier 区分高可信 vs 低可信生成档。
   */
  questions: PoolQuestion[];
  /** subject profile 的 sourcingRoutePreference → 播种 routePreference。key=subjectId。 */
  routePreferenceBySubject: Record<string, SupplyRoute[]>;
  /**
   * review FINDING #3：per-subject 的 quiz_gen 生成方法偏好（material_grounded vs closed_book），
   * 据 sourcingRoutePreference token 推导。key=subjectId。无 quiz_gen 偏好 → 该 subject 缺省不设。
   */
  generationMethodBySubject?: Record<string, 'material_grounded' | 'closed_book'>;
  /**
   * 「MFI/诊断选题反复缺近-θ̂ 题」的信号：本扫描器据现有题的 b 锚是否落在 |b−θ̂|≤窗口内判定
   * （无需历史选题日志——「池里根本没有近-θ̂ 题」就是「诊断反复缺」的结构性根因）。
   */
}

// ── source tier 映射（4 档 provenance → 3 档获取尺度）────────────────────────

/**
 * 把一道题的 4 档 provenance tier（deriveSourceTier）映射成本引擎的 3 档**获取尺度**：
 *   provenance tier 1 authentic（真题/录入）  → 获取档 1（高可信，manual/accepted/ingested）
 *   provenance tier 2 sourced（web 既存题）    → 获取档 2（中可信）
 *   provenance tier 3 material / 4 generated   → 获取档 3（生成/草稿级，llm-only）
 *
 * Task 13 字面要求：「manual/accepted = high tier 1, web_sourced = tier 2, llm-only/draft =
 * tier 3」。manual/accepted 真题在 provenance 里走 tier 1（authentic 经 ingestion marker）；
 * 纯 manual 无 ingestion marker 的题在 provenance 里会落 tier 4（generated）——但 Task 13 要求
 * 把「人工/已接受」当**最高获取档**。本映射用 source 列做这层修正：source='manual' / 'imported'
 * （人工录入 / 人工导入既存题）当获取档 1；其余按 provenance tier 降档。这样：
 *   - 真正的真题（带 ingestion_session_id）→ provenance 1 → 获取 1 ✓
 *   - 人工题（source='manual'，无 ingestion marker）→ source 修正 → 获取 1 ✓
 *   - web_sourced 已通过 source_verify 的 active 题 → provenance 2 → 获取 2 ✓
 *   - llm-only / 草稿（quiz_gen / variant / 未 verify）→ provenance 3|4 → 获取 3 ✓
 *
 * **`'embedded'` 刻意不在此集合**（review FINDING #3 修正）：source='embedded' 行是
 * embedded_check_generate.ts 写的 **AI 生成练习检测题**（provenance.ts §MIX-LAYER DEFENCE：
 * 无 ingestion_session_id → deriveSourceTier 正确落 tier 4 'generated'）。若把 embedded 当
 * 获取档 1，「只被 embedded AI 检测题覆盖」的 KC 会误判 hasHighTier=true → R2 永不请求真正
 * 的高可信题。embedded 是低可信生成档（→ 获取档 3），故按 provenance tier 降档，不进白名单。
 */
const HIGH_TIER_MANUAL_SOURCES = new Set(['manual', 'imported']);

export function acquisitionTierForQuestion(q: PoolQuestion): 1 | 2 | 3 {
  if (HIGH_TIER_MANUAL_SOURCES.has(q.source)) return 1;
  const { tier } = deriveSourceTier({ source: q.source, metadata: q.metadata });
  if (tier === 1) return 1;
  if (tier === 2) return 2;
  return 3; // provenance tier 3 (material) + 4 (generated) → 获取档 3（生成/草稿级）
}

// ── difficulty band 归类 ──────────────────────────────────────────────────────

/**
 * 据题的 b 锚（calibrationB 优先，否则 difficulty 弱锚）相对 KC 的 θ̂ 归到一个难度档。
 * 窗口（logit 尺度）对齐架构 doc §2 的 σ_b≈0.75 + 选题 MFI 近-θ̂ 窗口：
 *   below   : b < θ̂ − NEAR_WINDOW
 *   near    : |b − θ̂| ≤ NEAR_WINDOW（诊断/MFI 最有用的格子）
 *   above   : θ̂ + NEAR_WINDOW < b ≤ θ̂ + STRETCH_WINDOW
 *   stretch : b > θ̂ + STRETCH_WINDOW
 */
export const NEAR_WINDOW = 0.75;
export const STRETCH_WINDOW = 1.5;

export function difficultyBandFor(b: number, thetaHat: number): DifficultyBand {
  const delta = b - thetaHat;
  if (delta < -NEAR_WINDOW) return 'below';
  if (delta <= NEAR_WINDOW) return 'near';
  if (delta <= STRETCH_WINDOW) return 'above';
  return 'stretch';
}

// review FINDING #4：`bAnchorFor`（calibrationB ?? difficultyToLogitB 弱锚兜底）已删除。
// 唯一 caller 是 R3，但 R3 现在只信真实 item_calibration.b（不拿 difficulty_proxy 当 band
// 真值），故弱锚兜底无处可用。`difficulty` 字段仍保留在 PoolQuestion 上（其它规则/未来用途）。

// ── 优先级 + 指纹 ─────────────────────────────────────────────────────────────

// 各缺口类的基础 demand 权重（架构 doc §6 Demand 信号的确定性 MVP 近似）。frontier-zero
// 是最硬的缺口（KC 根本无题，选题层无可挑），故权重最高。
const GAP_BASE_PRIORITY: Record<SupplyGapKind, number> = {
  frontier_zero: 1.0,
  diagnostic: 0.7,
  source_quality: 0.5,
  format_diversity: 0.4,
};

/**
 * 优先级 = 基础 demand × 不确定性放大。低 evidence（新知）+ 高不确定 θ̂ 的缺口更紧急
 * （供给侧的「先建脚手架」语义，架构 doc §5/§6）。归一到 (0,1]。
 */
function computePriority(gapKind: SupplyGapKind, evidenceCount: number): number {
  const base = GAP_BASE_PRIORITY[gapKind];
  // evidence 越少越紧急（新 KC 先补题）；evidence 多了缺口仍在则降一档（已有些题，没那么急）。
  const noveltyBoost = evidenceCount === 0 ? 1.0 : 1 / (1 + Math.log1p(evidenceCount));
  return Math.min(1, base * noveltyBoost);
}

/**
 * 稳定指纹：同一 (subject, KC 集合, kind, band, gapKind, minSourceTier) 永远算出同一指纹，
 * 让重复扫描更新同一目标而非洪泛新目标（架构 doc §Target Lattice fingerprint 契约）。
 */
export function targetFingerprint(parts: {
  subjectId: string;
  knowledgeIds: string[];
  kind: string;
  difficultyBand: DifficultyBand;
  gapKind: SupplyGapKind;
  minSourceTier: 1 | 2 | 3;
}): string {
  const kids = [...parts.knowledgeIds].sort().join(',');
  return [
    parts.subjectId,
    kids,
    parts.kind,
    parts.difficultyBand,
    parts.gapKind,
    `t${parts.minSourceTier}`,
  ].join('|');
}

// recall-style 题型（重背，原题复用）——据 rotationClassForKind 复用既有 ADR-0030 路由分类，
// 不在此重定义题型→class 映射（单一真相）。
function isRecallKind(kind: QuestionKindT): boolean {
  return rotationClassForKind(kind) === 'recall';
}

// 客观题（可机判，校准首选 grounded 客观题）。判分路由落 exact/keyword（OBJECTIVE_JUDGE_ROUTES，
// src/server/mastery/personalized-difficulty.ts）的题型：choice/true_false → exact，
// fill_blank → exact|keyword（defaultJudgeKindForQuestion）。三者皆 active-PPI 可标定。
const OBJECTIVE_KINDS = new Set<QuestionKindT>(['choice', 'true_false', 'fill_blank']);

// review FINDING #2：R3 诊断/校准目标必须请求**客观** kind。active-PPI 校准（Phase 6）只在
// OBJECTIVE_JUDGE_ROUTES（exact/keyword）判分的题上产标签——一个请求 kind='any' 的 R3 目标可能
// 拿回非客观题（semantic 判分），它永远产不出校准标签，缺口永远填不上。choice 的判分路由恒为
// exact（defaultJudgeKindForQuestion：choice/true_false → exact，无 rubric 依赖），是最稳的客观题型。
const R3_CALIBRATION_KIND: QuestionKindT = 'choice';

// review FINDING #1/#6：覆盖深度阈值——一个 active-goal KC 的**可用（non-draft）**题数 < 此值
// 即「前沿/覆盖不足」，R1 发一个 frontier/coverage 目标（架构 doc §Scanner Rules 1「fewer than
// 2 active questions」）。draft 已在 loadQuestionPool 过滤掉，故这里数的就是可用题。
const COVERAGE_DEPTH_THRESHOLD = 2;

// ── 纯扫描器（Task 13 Step 2 的四条规则）──────────────────────────────────────

/**
 * 确定性缺口扫描：吃已加载输入，产出 QuestionSupplyTarget[]（已按 priority 降序排）。
 * 纯函数——无 IO、无随机、无时钟（id 由 caller 注入的 makeId 生成，测试可注入确定性 id）。
 *
 * 四条规则（Task 13 Step 2，权威）：
 *   R1 frontier_zero    : KC 的可用题数 < COVERAGE_DEPTH_THRESHOLD → 一个 coverage 目标
 *                         （desiredCount 补齐到阈值；建脚手架，band=near）。
 *   R2 source_quality   : 某 KC 只有低获取档（档 3 llm-only/草稿）题 → 一个更高获取档目标（minSourceTier=2）。
 *   R3 diagnostic       : 某 KC **没有近-θ̂ 题**（无题 effectiveB 落 'near' band）→ 一个 calibrationCandidate 目标（band=near）。
 *   R4 format_diversity : 某 KC **只有 recall 题** → 一个 application/transfer 目标。
 *
 * review FINDING #6：触发面 = **全部 active-goal KC**（不再因「首次 FSRS 入册」而停扫）。零题 KC 只产
 * R1（无池可分析 tier/band/kind）；有题但仍 thin（< 阈值）的 KC 既产 R1（补深度）也走 R2-R4（补质量/
 * 诊断/题型）；题数 ≥ 阈值的 KC 跳过 R1，仍走 R2-R4（这些规则是结构性缺口，自限不洪泛）。
 */
export function scanCoverageGaps(
  input: ScanInput,
  makeId: () => string = () => Math.random().toString(36).slice(2),
): QuestionSupplyTarget[] {
  const targets: QuestionSupplyTarget[] = [];

  // 现有题按 KC 索引（一题挂多 KC → 每个 KC 桶都收）。
  const questionsByKid = new Map<string, PoolQuestion[]>();
  for (const q of input.questions) {
    for (const kid of q.knowledgeIds) {
      const list = questionsByKid.get(kid) ?? [];
      list.push(q);
      questionsByKid.set(kid, list);
    }
  }

  const push = (
    f: FrontierKnowledgeInput,
    gapKind: SupplyGapKind,
    fields: {
      kind: string;
      difficultyBand: DifficultyBand;
      desiredCount: number;
      minSourceTier: 1 | 2 | 3;
      reason: string;
      constraints: QuestionSupplyTarget['constraints'];
    },
  ) => {
    const fingerprint = targetFingerprint({
      subjectId: f.subjectId,
      knowledgeIds: [f.knowledgeId],
      kind: fields.kind,
      difficultyBand: fields.difficultyBand,
      gapKind,
      minSourceTier: fields.minSourceTier,
    });
    const routePreference = input.routePreferenceBySubject[f.subjectId] ?? [];
    targets.push({
      id: makeId(),
      fingerprint,
      gapKind,
      subjectId: f.subjectId,
      knowledgeIds: [f.knowledgeId],
      kind: fields.kind,
      difficultyBand: fields.difficultyBand,
      desiredCount: fields.desiredCount,
      minSourceTier: fields.minSourceTier,
      routePreference,
      // review FINDING #3：当 quiz_gen 在路由偏好里时，带上 subject 的生成方法偏好
      // （material_grounded vs closed_book），dispatcher 据此设 quiz_gen job 的 generation_method。
      ...(routePreference.includes('quiz_gen') && input.generationMethodBySubject?.[f.subjectId]
        ? { preferredGenerationMethod: input.generationMethodBySubject[f.subjectId] }
        : {}),
      priority: computePriority(gapKind, f.evidenceCount),
      reason: fields.reason,
      constraints: fields.constraints,
    });
  };

  for (const f of input.frontier) {
    const pool = questionsByKid.get(f.knowledgeId) ?? [];

    // ── R1: 可用题数 < 覆盖深度阈值 → coverage 目标（补齐到阈值）─────────────
    // review FINDING #1/#6：pool 已是 non-draft 可用题（draft 在 loadQuestionPool 过滤）。
    // 阈值化（< COVERAGE_DEPTH_THRESHOLD）替代旧的「pool.length === 0」单点判定，让一个只有
    // 1 道可用题（已入册但 thin）的 KC 仍能补到目标深度（架构 doc §Scanner Rules 1）。
    if (pool.length < COVERAGE_DEPTH_THRESHOLD) {
      push(f, 'frontier_zero', {
        kind: 'any',
        difficultyBand: 'near',
        // 补齐到阈值（零题 → 2；1 题 → 1）。
        desiredCount: COVERAGE_DEPTH_THRESHOLD - pool.length,
        // 新知点该有至少一道中高可信源题（架构 doc §Scanner Rules 1）。
        minSourceTier: 2,
        reason:
          pool.length === 0
            ? `frontier/new-check knowledge ${f.knowledgeId} has zero questions`
            : `knowledge ${f.knowledgeId} is below coverage depth (${pool.length}/${COVERAGE_DEPTH_THRESHOLD} usable questions); needs more depth`,
        constraints: {},
      });
      if (pool.length === 0) continue; // 零题无池可分析 R2/R3/R4。
    }

    // ── R2: 只有低获取档（档 3）题 → 一个更高获取档目标 ──────────────────────
    const tiers = pool.map(acquisitionTierForQuestion);
    const hasHighTier = tiers.some((t) => t <= 2);
    if (!hasHighTier) {
      push(f, 'source_quality', {
        kind: 'any',
        difficultyBand: 'near',
        desiredCount: 1,
        minSourceTier: 2,
        reason: `knowledge ${f.knowledgeId} has only low-tier (llm-only / draft) questions; need a higher-tier item`,
        constraints: {
          avoidDuplicateOfQuestionIds: pool.map((q) => q.id),
        },
      });
    }

    // ── R3: 没有近-θ̂ 题 → calibrationCandidate（诊断/MFI 缺口）──────────────
    // 「MFI/诊断选题反复缺近-θ̂ 题」的结构性根因 = 池里根本没有 b 落 'near' band 的**可靠锚**题。
    //
    // review FINDING #4 修正——**band 归类用 effectiveB（= b_calib ?? b_anchor ?? b），与
    //   mastery/selection 同一 b 解析**（src/server/mastery/recalibration effectiveB，state.ts
    //   updateThetaForAttempt 也读它）。PoolQuestion.calibrationB 现在装的就是 effectiveB（在
    //   loadQuestionPool 算好；无 item_calibration 行 → null）。一道**已重标定**的题（b_calib 已
    //   firm-up）不会再因供给扫描器只看陈旧 b 列而被误判 mis-banded。
    //   与 R3「只信真实标定」**不冲突**：effectiveB 退回 b_anchor ?? b 时这两列是 ItemPriorTask 写的
    //   冷启**真锚**（real anchor，logit 尺度），不是 difficultyToLogitB(difficulty) 弱 proxy。
    //   effectiveB===null 恰好等价于「无 item_calibration 行 = 纯 difficulty proxy」→ 跳过不算可靠锚。
    //
    // review FINDING #5 修正——**删除恒真的 `&& mfiScore > 0` 死子句**：Rasch Fisher info
    //   p(1−p) 对任何有限 θ̂/b 恒 > 0（p∈(0,1)），该子句永不为假，从不构成信息量门槛；保留它
    //   只会让人误以为这里有个 MFI 阈值闸（其实没有）。诊断缺口由「band='near' 的可靠锚是否存在」
    //   单独判定即可。
    const hasNearTheta = pool.some((q) => {
      if (q.calibrationB === null) return false; // 无可靠锚（无 item_calibration 行）不算近-θ̂ 锚。
      return difficultyBandFor(q.calibrationB, f.thetaHat) === 'near';
    });
    if (!hasNearTheta) {
      push(f, 'diagnostic', {
        // review FINDING #2：校准目标必须是**客观题**（exact/keyword 判分），否则拿回的非客观题
        // 永远产不出 active-PPI 校准标签。choice 判分恒 exact（OBJECTIVE_KINDS / R3_CALIBRATION_KIND）。
        kind: R3_CALIBRATION_KIND,
        difficultyBand: 'near',
        desiredCount: 1,
        // 校准级证据要 grounded 客观题（架构 doc §3）→ 要中可信以上源。
        minSourceTier: 2,
        reason: `knowledge ${f.knowledgeId} lacks a near-theta_hat objective item (theta_hat=${f.thetaHat.toFixed(2)}); diagnostic/MFI selection repeatedly under-served`,
        // objectiveOnly：route-planner 走客观题源（sourcing_web / author_question），不走录入/图。
        constraints: { calibrationCandidate: true, objectiveOnly: true },
      });
    }

    // ── R4: 只有 recall 题 → 一个 application/transfer 目标 ──────────────────
    const allRecall = pool.every((q) => isRecallKind(q.kind));
    if (allRecall) {
      push(f, 'format_diversity', {
        kind: 'short_answer', // application/transfer 代表题型（ADR-0030 application class）。
        difficultyBand: 'near',
        desiredCount: 1,
        minSourceTier: 3, // 题型多样性属探索级，生成题可接受。
        reason: `knowledge ${f.knowledgeId} has only recall-style items; need an application/transfer item`,
        constraints: {},
      });
    }
  }

  // 按 priority 降序（稳定：同 priority 保插入序）。
  return targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.priority - a.t.priority || a.i - b.i)
    .map(({ t }) => t);
}

export { OBJECTIVE_KINDS };

// ── IO 加载器（读 DB → 喂纯扫描器）────────────────────────────────────────────
//
// must-not（架构 doc §Services）：不调 LLM、不插题、不晋升 draft、不决定今日练题顺序。
// 只读：learning_item / material_fsrs_state / question / item_calibration / mastery_state。

const COLD_START_THETA = 0;
const COLD_START_PRECISION = 1;

/**
 * subject profile 的 per-kind sourcingRoutePreference（值 token 'sourced'|'material'|
 * 'closed_book'|'variant'）→ 本引擎的 SupplyRoute 播种。across-kind 去重并保序：
 *   sourced     → sourcing_web
 *   material    → quiz_gen（material_grounded 走 quiz_gen 队列，架构 doc §Route Planner 映射）
 *   closed_book → quiz_gen（closed_book 也走 quiz_gen）
 *   variant     → author_question（变体生成最接近的既有面是拟题草稿）
 * 无 sourcingRoutePreference → 空数组（route-planner 兜底 [author_question, sourcing_web]）。
 */
const ROUTE_TOKEN_MAP: Record<string, SupplyRoute> = {
  sourced: 'sourcing_web',
  material: 'quiz_gen',
  closed_book: 'quiz_gen',
  variant: 'author_question',
};

export function seedRoutePreference(profile: SubjectProfile): SupplyRoute[] {
  const pref = profile.sourcingRoutePreference;
  if (!pref) return [];
  const seen = new Set<SupplyRoute>();
  const out: SupplyRoute[] = [];
  for (const tokens of Object.values(pref)) {
    for (const token of tokens ?? []) {
      const route = ROUTE_TOKEN_MAP[token];
      if (route && !seen.has(route)) {
        seen.add(route);
        out.push(route);
      }
    }
  }
  return out;
}

/**
 * review FINDING #3：从 subject profile 的 sourcingRoutePreference token 推导 quiz_gen 的
 * **生成方法偏好**（material→material_grounded，closed_book→closed_book）。`material` 与
 * `closed_book` 都映射成 quiz_gen 队列（ROUTE_TOKEN_MAP），但生成方法不同——quiz_gen handler
 * honor 这层区分（material_grounded 拉真原文 grounding vs closed_book 闭卷生成）。
 *
 * 首个出现的 quiz_gen-类 token（across-kind 保序）赢——与 seedRoutePreference 的「首现保序」
 * 一致：profile 把哪条排前，就用哪个生成方法。两者都没出现 → undefined（无 quiz_gen 偏好）。
 */
export function seedGenerationMethod(
  profile: SubjectProfile,
): 'material_grounded' | 'closed_book' | undefined {
  const pref = profile.sourcingRoutePreference;
  if (!pref) return undefined;
  for (const tokens of Object.values(pref)) {
    for (const token of tokens ?? []) {
      if (token === 'material') return 'material_grounded';
      if (token === 'closed_book') return 'closed_book';
    }
  }
  return undefined;
}

/**
 * 加载待扫的 active-goal KC：active learning item（status IN ['active','in_progress']）的全部 KC。
 *
 * review FINDING #6 修正——**删除「无 material_fsrs_state 行才算前沿」的闸**。旧实现把一个 KC 在
 * **首次** source_verify/quiz_verify 晋升题（写入第一条 material_fsrs_state 行）后立刻踢出扫描面，
 * 于是一个只入册了 1 道题的 thin KC 再也不被扫——即使它仍需补深度/补客观锚/补题型。现在扫**全部**
 * active-goal KC，让覆盖深度阈值（R1 < COVERAGE_DEPTH_THRESHOLD 可用题）与 R2/R3/R4 的结构性缺口
 * 判定来决定发不发目标（这些规则自限：题数够 + 质量够 + 有近-θ̂ 锚 + 题型多样 → 零目标，不洪泛）。
 *
 * 每个 KC 配上 mastery_state 的 θ̂/precision/evidence（冷启兜底）+ 经 getEffectiveDomain 派生的
 * subjectId（科目是视角，派生轴，不给 KC 加 subject 列）。
 */
async function loadFrontierKnowledge(db: Db): Promise<FrontierKnowledgeInput[]> {
  const items = await db
    .select({ knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(inArray(learning_item.status, ['active', 'in_progress']));
  const candidateKids = [...new Set(items.flatMap((i) => i.knowledge_ids ?? []))];
  if (candidateKids.length === 0) return [];

  const out: FrontierKnowledgeInput[] = [];
  for (const kid of candidateKids) {
    const state = await getMasteryState(db, kid, 'knowledge');
    let subjectId: string;
    try {
      subjectId = resolveSubjectProfile(await getEffectiveDomain(db, kid)).id;
    } catch {
      subjectId = resolveSubjectProfile(null).id;
    }
    out.push({
      knowledgeId: kid,
      subjectId,
      thetaHat: state?.theta_hat ?? COLD_START_THETA,
      thetaPrecision: state?.theta_precision ?? COLD_START_PRECISION,
      evidenceCount: state?.evidence_count ?? 0,
    });
  }
  return out;
}

/**
 * 加载现有**可用**题池里挂了任一 active-goal KC 的题 + 它们的 effectiveB（= b_calib ?? b_anchor ?? b）。
 * 只取与 active-goal KC 相关的题（按 KC 过滤，非全库扫描）。
 *
 * review FINDING #1——**过滤掉 draft_status='draft'**：草稿（未验证/被拒）不是可用 item，不该被当作
 * 已覆盖而压制 R1/R2。复用既有 draft-exclusion 三值逻辑安全谓词（mirror due-list.ts `notDraftQuiz`
 * / variant-rotation.ts `notDraft`：`draft_status IS NULL OR draft_status != 'draft'`——NULL/已晋升
 * 留池，仅字面 'draft' 排除）。一个唯一题是被拒 draft 的 KC 于是正确留着缺口（R1/R2 复发），fingerprint
 * cooldown（dispatcher）节流重复派发。
 *
 * review FINDING #4——同时读 b_anchor / b_calib，PoolQuestion.calibrationB 装 effectiveB（与
 * mastery/selection 同一 b 解析，src/server/mastery/recalibration effectiveB）。无 item_calibration
 * 行 → effectiveB=null（纯 difficulty proxy，R3 不当可靠锚）。
 */
async function loadQuestionPool(db: Db, frontierKids: string[]): Promise<PoolQuestion[]> {
  if (frontierKids.length === 0) return [];
  // JSONB 包含：question.knowledge_ids 与 frontierKids 有交集。逐 KC OR（mirror stream-store 的
  // @> 包含查询，避免全表 jsonb 解析）。
  const orConds = frontierKids.map(
    (kid) => sql`${question.knowledge_ids} @> ${JSON.stringify([kid])}::jsonb`,
  );
  // review FINDING #1：draft-exclusion 三值逻辑安全谓词（NULL/已晋升留池，仅 'draft' 排除）。
  const notDraft = or(isNull(question.draft_status), ne(question.draft_status, 'draft'));
  const rows = await db
    .select({
      id: question.id,
      kind: question.kind,
      source: question.source,
      metadata: question.metadata,
      difficulty: question.difficulty,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(and(sql`(${sql.join(orConds, sql` OR `)})`, notDraft));
  if (rows.length === 0) return [];

  // item_calibration（track='hard'）批量读：b / b_anchor / b_calib → effectiveB（FINDING #4）。
  const qids = rows.map((r) => r.id);
  const calRows = await db
    .select({
      question_id: item_calibration.question_id,
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
    })
    .from(item_calibration)
    .where(and(inArray(item_calibration.question_id, qids), eq(item_calibration.track, 'hard')));
  const effectiveBByQid = new Map(
    calRows.map((r) => [
      r.question_id,
      effectiveB({ b: r.b, b_anchor: r.b_anchor, b_calib: r.b_calib }),
    ]),
  );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as QuestionKindT,
    source: r.source,
    metadata: r.metadata ?? null,
    difficulty: r.difficulty,
    calibrationB: effectiveBByQid.get(r.id) ?? null,
    knowledgeIds: r.knowledge_ids ?? [],
  }));
}

/**
 * 端到端只读发现：读 DB → 组装 ScanInput → 跑纯扫描器 → QuestionSupplyTarget[]（priority 降序）。
 * 派发到获取面是 dispatcher.ts 的活；本函数纯发现，零写、零 LLM。
 */
export async function discoverSupplyTargets(
  db: Db,
  makeId?: () => string,
): Promise<QuestionSupplyTarget[]> {
  const frontier = await loadFrontierKnowledge(db);
  const frontierKids = frontier.map((f) => f.knowledgeId);
  const questions = await loadQuestionPool(db, frontierKids);

  // 按 subjectId 播种 routePreference + 生成方法偏好（去重——同 subject 只算一次 seed）。
  const routePreferenceBySubject: Record<string, SupplyRoute[]> = {};
  const generationMethodBySubject: Record<string, 'material_grounded' | 'closed_book'> = {};
  for (const f of frontier) {
    if (!(f.subjectId in routePreferenceBySubject)) {
      const profile = subjectProfiles[f.subjectId] ?? resolveSubjectProfile(f.subjectId);
      routePreferenceBySubject[f.subjectId] = seedRoutePreference(profile);
      // review FINDING #3：保留 material vs closed_book 生成方法区分。
      const gm = seedGenerationMethod(profile);
      if (gm) generationMethodBySubject[f.subjectId] = gm;
    }
  }

  return scanCoverageGaps(
    { frontier, questions, routePreferenceBySubject, generationMethodBySubject },
    makeId,
  );
}

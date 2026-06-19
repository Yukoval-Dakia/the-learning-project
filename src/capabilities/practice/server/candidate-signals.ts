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
import type { Db, Tx } from '@/db/client';
import { item_calibration, item_family_calibration } from '@/db/schema';
import { batchResolveFamilyKeys } from '@/server/mastery/family-key';
import {
  type FamilyCalibrationRow,
  effectiveFamilyB,
} from '@/server/mastery/personalized-difficulty';
import { effectiveB } from '@/server/mastery/recalibration';
import { effectiveThetaForKc, getMasteryState } from '@/server/mastery/state';
import { and, eq, inArray } from 'drizzle-orm';
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
 *   the EFFECTIVE theta = θ_global(domain-of-KC) + θ_KC (effectiveThetaForKc). With
 *   HIERARCHICAL_ELO_ENABLED=false (DEFAULT) effectiveThetaForKc returns θ_KC
 *   UNCHANGED and resolves no domain/global row, so this read path is BYTE-IDENTICAL
 *   to today (weakest-by-θ_hat, same precision). With it on, a new KC of a strong
 *   domain compares at its inherited effective ability rather than cold 0.
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
): Promise<{ thetaHat?: number; thetaPrecision?: number; evidenceCount: number }> {
  if (knowledgeIds.length === 0) {
    return { thetaHat: undefined, thetaPrecision: undefined, evidenceCount: 0 };
  }
  let weakestTheta = Number.POSITIVE_INFINITY;
  let weakestPrecision = COLD_START_PRECISION;
  let weakestEvidence = COLD_START_EVIDENCE;
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
    }
  }
  return {
    thetaHat: weakestTheta,
    thetaPrecision: weakestPrecision,
    evidenceCount: weakestEvidence,
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
  const { thetaHat, thetaPrecision, evidenceCount } = await aggregateWeakestKc(db, knowledgeIds);
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
  let mfi: number | undefined;
  let diag: number | undefined;
  let scoreKind: SelectionCandidateSignal['scoreKind'];
  if (!recallLocked && thetaHat !== undefined && b !== undefined) {
    const useEarlyKlp =
      EARLY_KLP_ENABLED && evidenceCount < EARLY_KLP_N && thetaPrecision !== undefined;
    if (useEarlyKlp && thetaPrecision !== undefined) {
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

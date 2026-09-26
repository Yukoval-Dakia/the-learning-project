import type { EvaluationRecordT, ScoringUnitResultT } from './judgment';
import type { ScoringBasisT, ScoringUnitT } from './scoring';

// ====================================================================
// YUK-1053 — 学习结算 · 纯决策层（grounding §8/§11；D13/D14/D15/D16）
// ====================================================================
//
// 本模块只做【无 IO 的确定性判定】：evaluation verdict → 局部证据（per-KC
// obs）→ FSRS 评级 / θ̂ 更新决策。DB 编排（锁序、快照 bracket、有序 replay）
// 在 `src/server/assessment/settle.ts`；本文件不得 import 任何 IO 依赖。
//
// 已批准决策映射（decisions 文件逐条对应）：
//
//   D13 — per-KC / group occurrence 局部证据：每 KC 每 occurrence 最多 1 obs，
//     success 1 / failure 0 / abstain。ambiguous/partial 未局部化 ⇒ abstain；
//     混合或部分判分（partial）记 abstain —— 「partial→1」与「worst-wins」
//     两条旧提案均已 REJECTED，本适配器不得复活它们。空白按声明 marking 计零
//     （scored_because='blank_marked_zero'）的单元【不产生掌握证据】（空白
//     默认不当作全部 KC failure —— 它不归因到任何 KC，而非归因到全部 KC）。
//     总分只聚合一次：本模块只【读】evaluation.aggregate / unit_results，
//     绝不二次聚合。
//
//   D13 工程约束 — bounded evidence adapter：现存 θ̂ updater
//     （updateThetaForAttempt）是 one-bit conjunctive updater：一次调用携带
//     单一 outcome 位、作用于整组 knowledgeIds。它【不能】表达 mixed per-KC
//     证据，也【不能】按 KC 集合多次调用（每 KC ≤1 obs）。因此本适配器：
//     仅当「所有非 abstain 的 KC 共享同一个位」时才发起【恰好一次】共享
//     global update；混合位/全 abstain/无 KC ⇒ 不更新，如实记 abstain 原因。
//     无 fractional θ、无新 IRT、无 self-report θ̂（D15）。
//
//   D14 — 三等级建议（group 级 verdict → FSRS 评级）：correct→good、
//     partial→hard、incorrect→again；invalid/unmapped/unsupported ⇒ none
//     （不调度）。手动覆盖（user-sourced provenance）承载在 evaluation.
//     provenance.source 上 —— 评级来自判分记录本身，judge 纠正绝不静默覆盖
//     用户已确认评级（守卫在 server settle 层；本层只暴露评级来源）。
//     group scheduler scope 显式版本化：SCOPE_V1 = 「判分组内全部非合成
//     KC 作为 knowledge 卡主体；组无 KC 时落 group root 的 question 卡」，
//     版本常量随结算证据封存。
//
//   D15 — provenance.source ∈ {automatic, manual, self_report}：
//     manual/self_report ⇒ 仅 FSRS 评级生效（用户评级）；θ̂ / calibration
//     不写（无 self-report θ̂，绝不推断 AI 正确性 —— 手动→θ̂ 精确映射未定
//     案，D9 工程细化）。automatic ⇒ 有效判分证据可独立更新 θ̂。
//
//   D16 — provenance.assisted=true（被答案帮助污染的证据）：得分在评估行
//     上保留，但本模块把它【排除在 hard mastery（θ̂）与 calibration 之外】；
//     显式手动 FSRS 允许（评级若来自用户 provenance 照常调度）。「不确定
//     ⇒ abstain」由 abstain 语义覆盖：assisted 证据对 mastery/calibration
//     不作贡献，不据此惩罚学习者。
//
// verdict 派生 = 与 YUK-1047 消费侧投影（projectEvaluationToJudgeResult，
// judge/evaluation-authority.ts）共享同一阈值与 no-points 语义 —— 单源：
// 消费投影调 deriveCoarseVerdict，结算读同一函数，判定语义不会分裂。

/** D14 group scheduler scope 版本（随结算证据封存；改 scope = 新版本号）。 */
export const SETTLEMENT_SCOPE_VERSION = 1 as const;

/** 组级判定（与 1047 消费投影同一 coarse 面）。 */
export type AssessmentVerdict = 'correct' | 'partial' | 'incorrect' | 'unsupported';

/** verdict 派生的结构化理由 —— 消费/结算两侧如实上报，不吞细节。 */
export type VerdictReason =
  | 'evaluation_pending'
  | 'aggregate_unresolved'
  | 'level_unmapped'
  | 'no_denominator'
  | 'score_zero'
  | 'score_full'
  | 'score_partial';

export interface CoarseVerdict {
  verdict: AssessmentVerdict;
  reason: VerdictReason;
  /** 聚合总分（points_total / level 聚合；unresolved/pending 为 null）。 */
  points: number | null;
  /** 归一化分母（发布侧满分；算不出来 = null，不硬造分母）。 */
  maxPoints: number | null;
  /** points/maxPoints ∈ [0,1]（可得时）；不可得 = null。 */
  normalized: number | null;
}

/** D14「partial」归一化阈值（与 1047 消费投影同一阈值，单源）。 */
export const VERDICT_CORRECT_THRESHOLD = 0.85 as const;

/**
 * 归一化分母：发布侧声明的可得满分（sum/capped_sum/weighted_sum 加法域；
 * threshold_levels 取最高档阈值）。加权单元按「自身权重 × 满分」折算；
 * capped 取 cap 封顶；算不出全局上限 ⇒ null —— 归一化不可得，不硬造分母。
 */
export function aggregateMaxPoints(basis: ScoringBasisT): number | null {
  const additive = basis.units.filter(
    (unit) => unit.criterion.kind !== 'holistic_level' && unit.points != null,
  );
  switch (basis.aggregation.kind) {
    case 'sum':
      return additive.reduce((sum, unit) => sum + (unit.points ?? 0), 0);
    case 'weighted_sum': {
      const weights = basis.aggregation.weights;
      const totalWeight = basis.units.reduce(
        (sum, unit) => sum + (weights[unit.scoring_unit_id] ?? 0),
        0,
      );
      if (totalWeight <= 0) return null;
      return additive.reduce(
        (sum, unit) => sum + (unit.points ?? 0) * (weights[unit.scoring_unit_id] ?? 0),
        0,
      );
    }
    case 'capped_sum':
      return Math.min(
        basis.aggregation.cap,
        additive.reduce((sum, unit) => sum + (unit.points ?? 0), 0),
      );
    case 'threshold_levels': {
      const thresholds = basis.aggregation.thresholds;
      return thresholds.length > 0 ? Math.max(...thresholds.map((t) => t.min_points)) : null;
    }
  }
}

/**
 * evaluation → 组级判定（与 1047 消费投影同一推导；结算读同一份）。
 *
 * - pending / aggregate 缺失 ⇒ unsupported（evaluation_pending）；
 * - unresolved 聚合 ⇒ unsupported（aggregate_unresolved —— pending_units /
 *   no_mapping / result_set_mismatch / invalid_result 均如实保留在
 *   record.aggregate.reason，这里不再枚举）；
 * - level 命中未映射档位（points==null）⇒ unsupported（level_unmapped，
 *   §4.4「不凭空造总分」的结算面对偶）；
 * - 分母不可得 ⇒ unsupported（no_denominator）；
 * - normalized ≤ 0 ⇒ incorrect；≥ 阈值 ⇒ correct；之间 ⇒ partial。
 */
export function deriveCoarseVerdict(
  record: Pick<EvaluationRecordT, 'status' | 'aggregate'>,
  basis: ScoringBasisT,
): CoarseVerdict {
  if (record.status === 'pending' || record.aggregate == null) {
    return {
      verdict: 'unsupported',
      reason: 'evaluation_pending',
      points: null,
      maxPoints: null,
      normalized: null,
    };
  }
  const aggregate = record.aggregate;
  if (aggregate.kind === 'unresolved') {
    return {
      verdict: 'unsupported',
      reason: 'aggregate_unresolved',
      points: null,
      maxPoints: null,
      normalized: null,
    };
  }
  const points = aggregate.points;
  if (points == null) {
    return {
      verdict: 'unsupported',
      reason: 'level_unmapped',
      points: null,
      maxPoints: null,
      normalized: null,
    };
  }
  const maxPoints = aggregateMaxPoints(basis);
  const normalized =
    maxPoints != null && maxPoints > 0 ? Math.min(1, Math.max(0, points / maxPoints)) : null;
  if (normalized == null) {
    return { verdict: 'unsupported', reason: 'no_denominator', points, maxPoints, normalized };
  }
  if (normalized <= 0) {
    return { verdict: 'incorrect', reason: 'score_zero', points, maxPoints, normalized };
  }
  if (normalized >= VERDICT_CORRECT_THRESHOLD) {
    return { verdict: 'correct', reason: 'score_full', points, maxPoints, normalized };
  }
  return { verdict: 'partial', reason: 'score_partial', points, maxPoints, normalized };
}

// ---------- D14 三等级建议 ----------

export type FsrsRatingLabel = 'again' | 'hard' | 'good';

/**
 * D14 三等级映射（universal，与 UNIVERSAL_RATING_FROM_OUTCOME 逐值一致；
 * 显式本地表达以固定结算契约 —— profile 覆盖属 UI/legacy lane，评估契约
 * 结算锁定 D14 三等级）：correct→good、partial→hard、incorrect→again、
 * unsupported/invalid/unmapped ⇒ null（不调度）。
 */
export function ratingForVerdict(verdict: AssessmentVerdict): FsrsRatingLabel | null {
  switch (verdict) {
    case 'correct':
      return 'good';
    case 'partial':
      return 'hard';
    case 'incorrect':
      return 'again';
    case 'unsupported':
      return null;
  }
}

// ---------- D13 局部证据 ----------

/** 单元证据分类（matched measurement：判定已本地化到 scoring unit）。 */
export type UnitEvidence =
  | { kind: 'full' } // 全部得分（该单元的判据全数命中）
  | { kind: 'zero' } // 零分（全错 —— 真实作答被判零）
  | { kind: 'partial' } // 部分得分（含未映射档位以外的部分档）
  | { kind: 'uninformative' } // 不产生掌握证据（blank_marked_zero / 零分单元 / 未决）
  | { kind: 'unmapped' }; // 无法定位判据维度（holistic 无 level / 结果形状矛盾）

/**
 * 单元 → 证据分类（纯函数）。
 *
 * - pending ⇒ uninformative（未决不算任何方向证据，绝不当零分）；
 * - blank_marked_zero ⇒ uninformative（空白计零是分数政策，不是掌握证据）；
 * - additive：points=0 单元 ⇒ uninformative（零分单元没有判据可命中，
 *   full/zero 都不可归因）；points_awarded<=0 ⇒ zero；>= unit.points ⇒ full；
 *   中间 ⇒ partial（判分器已保证 ≤ 发布上限，本函数不再校验）；
 * - holistic：level_points 声明时按映射值分档（0 ⇒ zero；满档 ⇒ full；其余
 *   partial）；未映射档位 ⇒ unmapped；纯档位 rubric（无映射）按 rank 分档
 *   （maxRank ⇒ full；rank=0 ⇒ zero；中间 ⇒ partial）；缺 matched.level_id
 *   ⇒ unmapped。
 */
export function classifyScoredUnit(unit: ScoringUnitT, result: ScoringUnitResultT): UnitEvidence {
  if (result.status === 'pending') return { kind: 'uninformative' };
  if (result.scored_because === 'blank_marked_zero') return { kind: 'uninformative' };
  if (unit.criterion.kind === 'holistic_level') {
    const levelId = result.matched?.level_id;
    if (levelId == null) return { kind: 'unmapped' };
    const levelPoints = unit.level_points ?? {};
    if (Object.keys(levelPoints).length > 0) {
      const mapped = levelPoints[levelId];
      if (mapped === undefined) return { kind: 'unmapped' };
      const maxMapped = Math.max(...Object.values(levelPoints));
      if (mapped <= 0) return { kind: 'zero' };
      if (maxMapped > 0 && mapped >= maxMapped) return { kind: 'full' };
      return { kind: 'partial' };
    }
    const levels = unit.criterion.levels;
    const matched = levels.find((level) => level.level_id === levelId);
    if (matched === undefined) return { kind: 'unmapped' };
    const maxRank = Math.max(...levels.map((level) => level.rank));
    if (matched.rank <= 0) return { kind: 'zero' };
    if (matched.rank >= maxRank) return { kind: 'full' };
    return { kind: 'partial' };
  }
  const max = unit.points ?? 0;
  if (max <= 0) return { kind: 'uninformative' };
  const awarded = result.points_awarded ?? 0;
  if (awarded <= 0) return { kind: 'zero' };
  if (awarded >= max) return { kind: 'full' };
  return { kind: 'partial' };
}

/** per-KC observation（每 KC 每 occurrence 最多一条）。 */
export type KcObservation =
  | { kc_id: string; bit: 0 | 1; basis: 'all_full' | 'all_zero' }
  | { kc_id: string; bit: 'abstain'; basis: 'no_supported_evidence' | 'mixed_or_partial' };

export interface UnitLocalizationInput {
  /** unit.scoring_unit_id → 其作答面所在的 part 集（无槽引用 = 全组）。 */
  unitPartIds: Map<string, Set<string>>;
  /** part_id → 该 part 的 KC 集（缺项 ⇒ 回落组级 KC）。 */
  partKcIds: Map<string, string[]>;
  /** 组级 KC 集（question.knowledge_ids 规范化后）。 */
  groupKcIds: string[];
}

/**
 * unit 作答面 → KC 集。slot_refs 与 evidence_slot_refs 均为空 ⇒ 组级单元
 * （material/group evidence），归组级 KC；否则并集其引用槽位所在 part 的
 * KC（part 未映射 ⇒ 回落组级）。YUK-1093 P1-4：evidence-only 单元（判据
 * 不直对作答槽、只挂 evidence_slot_refs）同样 part-局部 —— unitPartIdsOf
 * 已把证据槽解析到所属 part，判据投票不得越过该 part 落到全组 KC 上。
 * KC 集为空 ⇒ null（不可归因，不计任何 KC 的票）。
 */
function unitKcs(unit: ScoringUnitT, loc: UnitLocalizationInput): Set<string> | null {
  const partIds =
    unit.slot_refs.length === 0 && unit.evidence_slot_refs.length === 0
      ? null // group-scoped unit
      : (loc.unitPartIds.get(unit.scoring_unit_id) ?? new Set<string>());
  const kcs = new Set<string>();
  if (partIds === null || partIds.size === 0) {
    for (const id of loc.groupKcIds) kcs.add(id);
  } else {
    for (const partId of partIds) {
      const partKcs = loc.partKcIds.get(partId) ?? loc.groupKcIds;
      for (const id of partKcs) kcs.add(id);
    }
  }
  return kcs.size === 0 ? null : kcs;
}

/**
 * D13 局部证据：单元判分按作答面归因到 KC，每 KC 至多一条 obs：
 *   - KC 无任何 informative 单元证据 ⇒ abstain(no_supported_evidence)；
 *   - 覆盖它的全部 informative 单元同判 full ⇒ bit=1（wrong-localized 对偶：
 *     同判 zero ⇒ bit=0）；
 *   - 混合或含 partial ⇒ abstain(mixed_or_partial) ——「ambiguous/partial 未
 *     局部化 ⇒ abstain」的原位执行，partial→1 / worst-wins 均已 REJECTED。
 *
 * uninformative / unmapped 单元不产生票（未决/空白/矛盾形状不惩罚学习者）。
 */
export function localizeKcObservations(
  basis: ScoringBasisT,
  unitResults: readonly ScoringUnitResultT[],
  loc: UnitLocalizationInput,
): KcObservation[] {
  const resultByUnit = new Map(unitResults.map((r) => [r.scoring_unit_id, r] as const));
  /** kc → informative 单元证据列表。 */
  const votes = new Map<string, UnitEvidence[]>();
  for (const unit of basis.units) {
    const result = resultByUnit.get(unit.scoring_unit_id);
    if (result === undefined) continue;
    const evidence = classifyScoredUnit(unit, result);
    if (evidence.kind === 'uninformative' || evidence.kind === 'unmapped') continue;
    const kcs = unitKcs(unit, loc);
    if (kcs === null) continue;
    for (const kc of kcs) {
      const list = votes.get(kc) ?? [];
      list.push(evidence);
      votes.set(kc, list);
    }
  }
  const observations: KcObservation[] = [];
  for (const kc of loc.groupKcIds) {
    const kcVotes = votes.get(kc) ?? [];
    if (kcVotes.length === 0) {
      observations.push({ kc_id: kc, bit: 'abstain', basis: 'no_supported_evidence' });
      continue;
    }
    const kinds = new Set(kcVotes.map((v) => v.kind));
    if (kinds.size === 1 && kinds.has('full')) {
      observations.push({ kc_id: kc, bit: 1, basis: 'all_full' });
    } else if (kinds.size === 1 && kinds.has('zero')) {
      observations.push({ kc_id: kc, bit: 0, basis: 'all_zero' });
    } else {
      observations.push({ kc_id: kc, bit: 'abstain', basis: 'mixed_or_partial' });
    }
  }
  // 范围外 KC（不在 groupKcIds 但被单元归因到）也如实观测 —— 票是有依据的。
  for (const kc of votes.keys()) {
    if (loc.groupKcIds.includes(kc)) continue;
    const kcVotes = votes.get(kc) ?? [];
    const kinds = new Set(kcVotes.map((v) => v.kind));
    if (kinds.size === 1 && kinds.has('full')) {
      observations.push({ kc_id: kc, bit: 1, basis: 'all_full' });
    } else if (kinds.size === 1 && kinds.has('zero')) {
      observations.push({ kc_id: kc, bit: 0, basis: 'all_zero' });
    } else {
      observations.push({ kc_id: kc, bit: 'abstain', basis: 'mixed_or_partial' });
    }
  }
  return observations;
}

// ---------- bounded evidence adapter（D13 工程约束） ----------

/** θ̂ 更新决策（共享 global update 只做一次；否则 abstain）。 */
export type ThetaDecision =
  | {
      kind: 'update';
      /** 本次恰好一次的共享 update 携带的单一位。 */
      outcome: 0 | 1;
      /** 参与 update 的非 abstain KC（按 id 排序）。 */
      knowledgeIds: string[];
    }
  | {
      kind: 'abstain';
      reason:
        | 'no_kc_evidence' // 无 KC / 全 abstain
        | 'mixed_kc_bits' // 非 abstain KC 位不一致（one-bit updater 表达不了）
        | 'provenance_excluded'; // D15/D16：manual/self_report/assisted 排除
    };

/**
 * bounded evidence adapter：per-KC obs → 至多一次共享 θ̂ update。
 *   - provenance 排除（D15/D16）优先：self/manual/assisted 不产生 θ̂ 更新；
 *   - 非 abstain KC 为空 ⇒ abstain（无证据，不是 failure）；
 *   - 非 abstain KC 共享同一位 ⇒ update(outcome=该位, knowledgeIds=该子集)；
 *   - 位不一致 ⇒ abstain —— one-bit conjunctive updater 无法表达 mixed
 *     证据，按 KC 多次调用又违反「每 KC ≤1 obs」，故 fail-closed 不更新。
 */
export function resolveThetaDecision(
  observations: readonly KcObservation[],
  provenance: { source: 'automatic' | 'manual' | 'self_report'; assisted: boolean },
): ThetaDecision {
  if (provenance.source !== 'automatic' || provenance.assisted) {
    return { kind: 'abstain', reason: 'provenance_excluded' };
  }
  const decided = observations.filter(
    (obs): obs is Extract<KcObservation, { bit: 0 | 1 }> => obs.bit !== 'abstain',
  );
  if (decided.length === 0) return { kind: 'abstain', reason: 'no_kc_evidence' };
  const bits = new Set(decided.map((obs) => obs.bit));
  if (bits.size !== 1) return { kind: 'abstain', reason: 'mixed_kc_bits' };
  const outcome = decided[0].bit;
  return {
    kind: 'update',
    outcome,
    knowledgeIds: [...decided.map((obs) => obs.kc_id)].sort(),
  };
}

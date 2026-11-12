import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { getMasteryState, globalThetaForDomain } from '@/kernel/read-models/mastery-state';
import {
  type EvidenceDemandV1T,
  buildCoverageEvidenceDemand,
  evidenceDemandToTargetContext,
  parseEvidenceDemand,
} from '@/kernel/supply-contracts';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  type DifficultyBand,
  type QuestionSupplyTarget,
  type SupplyGapKind,
  resolveBandLevelTarget,
  seedGenerationMethod,
  seedRoutePreference,
  targetFingerprint,
} from '../../../supply/public';

// Demand → QuestionSupplyTarget for the existing dispatcher.
// subjectId walks the KC's effective domain. fingerprint is the shared
// targetFingerprint so this adapter and the scanner share one cooldown key.

export interface Demand {
  /** 必填，单 KC. */
  knowledgeId: string;
  /** 结构轴 unit==='篇'，写入 target.constraints.compositeParentOnly. */
  compositeParentOnly?: boolean;
  /** 源档底线 (1|2|3)，写入 target.minSourceTier. 缺省 2. */
  minSourceTier?: 1 | 2 | 3;
  /** 请求侧 kind 标签。缺省 'any'. */
  kind?: string;
  /** 错因，塞进 target.reason，不扩 JobData. */
  cause?: string;
  /** R1-R4 信封，映射 SupplyGapKind. 未知/缺省 → frontier_zero. */
  gapType?: string;
  priority?: number;
  /** Optional full Supply-v2 demand. Legacy callers omit it and receive a compatibility demand. */
  evidenceDemand?: EvidenceDemandV1T;
  /** 必填. */
  limit: number;
}

// 覆盖缺口的带仍是 near（相对该 KC 的 θ̂，与扫描器 R1 相同）。
// 1–5 档在 levelTarget 里按 θ̂ 反算，不再把 near 写成固定的 3。
function difficultyBandFor(_demand: Demand): DifficultyBand {
  return 'near';
}

const GAP_TYPE_TO_SUPPLY_GAP_KIND: Record<string, SupplyGapKind> = {
  frontier_zero: 'frontier_zero',
  source_quality: 'source_quality',
  diagnostic: 'diagnostic',
  format_diversity: 'format_diversity',
};

function supplyGapKindFor(demand: Demand): SupplyGapKind {
  if (demand.gapType && GAP_TYPE_TO_SUPPLY_GAP_KIND[demand.gapType]) {
    return GAP_TYPE_TO_SUPPLY_GAP_KIND[demand.gapType];
  }
  return 'frontier_zero';
}

/**
 * Adapt a Demand + computed gap into a QuestionSupplyTarget the existing dispatcher can
 * route. async: subjectId resolution walks the KC's effective domain via DB.
 *
 * fingerprint 调 import 的 targetFingerprint (绝不复刻算法 — 复刻=cooldown 失效=无界付费
 * re-dispatch). subjectId resolution: getEffectiveDomain → resolveSubjectProfile.id；
 * 节点缺失/未建 (零库 / 错题 caller) → 退 resolveSubjectProfile(null).id，绝不留空/硬编码。
 *
 * cause→prompt 透传缺口: QuizGenJobData/SourcingJobData payload 当前不带 cause；
 * 把 cause 塞进 target.reason (人读字符串，dispatcher 已留痕)。扩 JobData 是后续增量。
 */
export async function demandToSupplyTarget(
  db: Db,
  demand: Demand,
  gap: number,
  makeId: () => string = newId,
): Promise<QuestionSupplyTarget> {
  let subjectId: string;
  let rawDomain: string | null = null;
  try {
    rawDomain = await getEffectiveDomain(db, demand.knowledgeId);
    subjectId = resolveSubjectProfile(rawDomain).id;
  } catch {
    // 节点缺失 / domain 未解 (零库 / 自由 caller) → 默认 subject.
    subjectId = resolveSubjectProfile(null).id;
  }
  const profile = resolveSubjectProfile(subjectId);
  const mastery = await getMasteryState(db, demand.knowledgeId);
  const thetaHat = (mastery?.theta_hat ?? 0) + (await globalThetaForDomain(db, rawDomain));

  const kind = demand.kind ?? 'any';
  const difficultyBand = difficultyBandFor(demand);
  const gapKind = supplyGapKindFor(demand);
  const minSourceTier: 1 | 2 | 3 = (demand.minSourceTier ?? 2) as 1 | 2 | 3;
  const knowledgeIds = [demand.knowledgeId];
  const evidenceDemand = demand.evidenceDemand
    ? parseEvidenceDemand(demand.evidenceDemand)
    : buildCoverageEvidenceDemand({
        subjectId,
        knowledgeIds,
        statement: `matcher needs ${gap} additional item(s) for ${demand.knowledgeId}`,
        kinds: [kind],
        difficultyBand,
        eligibleCount: demand.limit,
        cause: { kind: 'selection_miss' },
      });
  if (
    evidenceDemand.subject_id !== subjectId ||
    !evidenceDemand.claim.knowledge_ids.includes(demand.knowledgeId)
  ) {
    throw new Error(
      `EvidenceDemand ${evidenceDemand.demand_id} does not match target subject/KC boundary`,
    );
  }

  // fingerprint: import targetFingerprint，与 target-discovery 同算法 → 同 demand 产同 fingerprint
  // (7 天 cooldown 前提). 绝不复刻算法.
  const fingerprint = targetFingerprint({
    subjectId,
    knowledgeIds,
    kind,
    difficultyBand,
    gapKind,
    minSourceTier,
  });

  return {
    id: makeId(),
    fingerprint,
    gapKind,
    subjectId,
    knowledgeIds,
    kind,
    difficultyBand,
    levelTarget: resolveBandLevelTarget(difficultyBand, thetaHat),
    desiredCount: gap,
    minSourceTier,
    // import seedRoutePreference (不硬编码空数组)；空 profile 退 [] → dispatcher 落 manual.
    routePreference: seedRoutePreference(profile),
    // quiz_gen 的 material vs closed_book 区分 (与 target-discovery seedGenerationMethod
    // 同款，单一真相)；undefined → dispatcher 退 minSourceTier 推导。
    preferredGenerationMethod: seedGenerationMethod(profile),
    priority: demand.priority ?? GAP_KIND_BASE_PRIORITY[gapKind],
    // cause→prompt 透传缺口: 把 demand.cause 塞进 reason (人读字符串，dispatcher 留痕)。
    reason: residualReason(demand, gap),
    // thread the demand's 篇-only structural axis into target.constraints so
    // the constraint reaches generation (dispatcher persists target.constraints
    // into the question_supply observability payload; route-planner reads sibling flags).
    // Only set when the demand declares it (additive; absent → unconstrained).
    constraints: demand.compositeParentOnly ? { compositeParentOnly: true } : {},
    context: evidenceDemandToTargetContext(evidenceDemand),
  };
}

// 缺省 priority base，词表对齐 target-discovery GAP_BASE_PRIORITY (单一真相在那边；这里只是
// demand 未显式给 priority 时的兜底基准，与扫描器同尺度便于观测对齐)。
const GAP_KIND_BASE_PRIORITY: Record<SupplyGapKind, number> = {
  frontier_zero: 1.0,
  placement_starter: 1.0,
  diagnostic: 0.7,
  source_quality: 0.5,
  format_diversity: 0.4,
  confusable_contrast: 0.6,
};

function residualReason(demand: Demand, gap: number): string {
  const causeSuffix = demand.cause ? ` (cause: ${demand.cause})` : '';
  return `matcher residual: KC ${demand.knowledgeId} short by ${gap} (limit ${demand.limit})${causeSuffix}`;
}

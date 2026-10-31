import { sql } from 'drizzle-orm';
import { masteryDecayBucket } from '@/core/mastery-freshness';
import {
  COMPONENT_DISAGREEMENT_RULE,
  type EvidenceAge,
  type JudgmentUnknown,
  type LearnerJudgment,
  type LearnerJudgmentBatch,
  type LearnerJudgmentInput,
  LearnerJudgmentInputSchema,
} from '@/core/schema/learner-judgment';
import type { RetentionReading } from '@/core/schema/scheduling-state';
import type { Db, Tx } from '@/db/client';
import { getNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import { getFsrsRetrievabilityByIds, selectedForgettingEngine } from '@/kernel/scheduling';
import { type MasteryProjection, getMasteryProjection } from './mastery-projection';

type DbLike = Db | Tx;
type MasteryReader = (db: DbLike, ids: string[]) => Promise<Map<string, MasteryProjection>>;
type ComponentRead<T> = { kind: 'available'; values: Map<string, T> } | JudgmentUnknown;

function unknown(reason: string): JudgmentUnknown {
  return { kind: 'unknown', reason };
}

// Reasons meaning a component did not answer at all (query/snapshot/engine
// failure), as opposed to honest per-item unknowns (cold start, inferred-only,
// insufficient evidence). Failure-semantics consumers key on these.
const COMPONENT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'mastery_component_unavailable',
  'retention_component_unavailable',
  'engine_selection_unavailable',
  'snapshot_unavailable',
  'caller_transaction_is_not_a_read_only_snapshot',
]);

function isComponentFailureReason(reason: string): boolean {
  return COMPONENT_FAILURE_REASONS.has(reason);
}

// The retention side is comparable only as a number: the port's FSRS reading or
// the candidate's score. A structured unknown reading is not a value.
function retentionValue(retention: LearnerJudgment['retention']): number | null {
  if (retention.kind !== 'available') return null;
  if (typeof retention.reading === 'number') return retention.reading;
  return retention.reading.kind === 'score' ? retention.reading.value : null;
}

function retentionUnavailableReason(retention: LearnerJudgment['retention']): string {
  if (retention.kind === 'unknown') return retention.reason;
  return typeof retention.reading === 'object' && retention.reading.kind === 'unknown'
    ? retention.reading.reason
    : 'missing_scheduling_state';
}

// An explainable divergence between the two incumbent component readings. The
// verdict only compares the already-published observables at the registered
// thresholds — it combines no likelihoods and claims no joint prediction.
function componentDisagreement(
  pfa: LearnerJudgment['p_correct_now'],
  retention: LearnerJudgment['retention'],
): LearnerJudgment['uncertainty']['component_disagreement'] {
  const rule = { high: COMPONENT_DISAGREEMENT_RULE.high, low: COMPONENT_DISAGREEMENT_RULE.low };
  const r = retentionValue(retention);
  if (pfa.kind === 'incumbent_pfa') {
    if (r === null) {
      return {
        kind: 'partial_coverage',
        missing: 'retention',
        reason: retentionUnavailableReason(retention),
      };
    }
    if (pfa.value >= rule.high && r < rule.low) {
      return {
        kind: 'divergence_observed',
        direction: 'ability_high_retention_low',
        rule,
        calibration: 'uncalibrated',
      };
    }
    if (pfa.value < rule.low && r >= rule.high) {
      return {
        kind: 'divergence_observed',
        direction: 'ability_low_retention_high',
        rule,
        calibration: 'uncalibrated',
      };
    }
    return { kind: 'no_divergence_observed', rule, calibration: 'uncalibrated' };
  }
  if (r !== null) {
    return { kind: 'partial_coverage', missing: 'ability', reason: pfa.reason };
  }
  return unknown('component_readings_not_comparable');
}

// Low observed ability uses the same registered low side as disagreement.
// It is not a new cutoff and it is not a joint likelihood.
function abilityClaim(
  pfa: LearnerJudgment['p_correct_now'],
  notEvaluable: boolean,
): LearnerJudgment['ability_claim'] {
  // A failed read is not a role verdict. Otherwise a goal node hides the failure
  // as 「不评掌握」 while other faces still throw.
  if (pfa.kind === 'unknown' && isComponentFailureReason(pfa.reason)) {
    return { kind: 'unavailable', reason: pfa.reason };
  }
  if (notEvaluable) {
    return { kind: 'not_evaluable', reason: 'knowledge_role_not_mastery_evaluable' };
  }
  if (pfa.kind === 'incumbent_pfa') {
    const rule = { low: COMPONENT_DISAGREEMENT_RULE.low };
    if (pfa.value < rule.low) return { kind: 'low_observed', rule, calibration: 'uncalibrated' };
    return { kind: 'observed', rule, calibration: 'uncalibrated' };
  }
  return { kind: 'insufficient_evidence', reason: pfa.reason };
}

// Growth is the existing freshness bucket (mild / stale), not a wider interval.
// last_outcome_at is the only practice clock the incumbent reading exposes.
function evidenceAge(
  claim: LearnerJudgment['ability_claim'],
  reading: MasteryProjection | undefined,
  asOf: Date,
): EvidenceAge {
  if (claim.kind !== 'low_observed' && claim.kind !== 'observed') {
    return { kind: 'not_applicable', reason: claim.reason };
  }
  const at = reading?.last_outcome_at ?? null;
  if (!reading || !at) return { kind: 'undated', reason: 'observed_evidence_without_timestamp' };
  const freshness = masteryDecayBucket(reading.evidence_count, at, asOf);
  if (freshness !== 'fresh' && freshness !== 'mild' && freshness !== 'stale') {
    return { kind: 'undated', reason: 'observed_evidence_without_timestamp' };
  }
  const idleDays = Math.max(0, Math.floor((asOf.getTime() - at.getTime()) / 86_400_000));
  return {
    kind: 'dated',
    idle_days: idleDays,
    freshness,
    growing: freshness !== 'fresh',
  };
}

function canDoClause(claim: LearnerJudgment['ability_claim']): string {
  switch (claim.kind) {
    case 'low_observed':
      return '会做：本人作答读数在低掌握一侧，这是不会，尚未个人校准';
    case 'observed':
      return '会做：本人作答读数不在低掌握一侧，尚未个人校准';
    case 'insufficient_evidence':
      return claim.reason === 'inferred_only'
        ? '会做：还不知道你会不会，只有知识关联推断，不是本人作答'
        : '会做：还不知道你会不会，本人作答证据不足';
    case 'not_evaluable':
      return '会做：这个节点不评掌握，不是不会';
    case 'unavailable':
      return '会做：掌握部件不可用，读取失败';
  }
}

function uncertaintyClause(age: EvidenceAge): string {
  switch (age.kind) {
    case 'dated':
      return age.freshness === 'stale'
        ? '不确定：作答已久未更新，不确定在增大，尚未个人校准'
        : age.growing
          ? '不确定：作答开始变旧，不确定在增大，尚未个人校准'
          : '不确定：作答还新，不确定未随闲置标成增大';
    case 'undated':
      return '不确定：有作答但没有时间，不能判断不确定是否在增大';
    case 'not_applicable':
      return '不确定：没有可随时间变宽的本人估计';
  }
}

// Qualitative only: no new predictive digits before the D6 threshold. A
// component failure stays a failure, and missing evidence stays「不知道你会不会」.
function judgementSentence(
  claim: LearnerJudgment['ability_claim'],
  retention: LearnerJudgment['retention'],
  disagreement: LearnerJudgment['uncertainty']['component_disagreement'],
  age: EvidenceAge,
): string {
  const canDo = canDoClause(claim);
  const remember =
    retentionValue(retention) !== null
      ? '记得：现役保持读数可用，尚未个人校准'
      : retention.kind === 'unknown' && isComponentFailureReason(retention.reason)
        ? '记得：保持部件不可用，读取失败'
        : '记得：暂无保持读数，还不知道';
  const divergence =
    disagreement.kind === 'divergence_observed'
      ? disagreement.direction === 'ability_high_retention_low'
        ? '分歧：会做读数高而保持读数低（可能会了但快忘）'
        : '分歧：保持读数高而会做读数低（可能记得但不会用）'
      : disagreement.kind === 'no_divergence_observed'
        ? '分歧：未见跨阈值的背离'
        : disagreement.kind === 'partial_coverage'
          ? '分歧：仅一端读数可用，暂无法判断'
          : '分歧：两端读数均不可用，还不知道';
  return `${canDo}；${remember}；${divergence}；${uncertaintyClause(age)}。`;
}

function judgment(
  id: string,
  mastery: ComponentRead<MasteryProjection>,
  retention: ComponentRead<RetentionReading>,
  asOf: Date,
  nonKcIds: ReadonlySet<string> = new Set(),
): LearnerJudgment {
  const entry = mastery.kind === 'available' ? mastery.values.get(id) : undefined;
  const memory = retention.kind === 'available' ? retention.values.get(id) : undefined;
  const ability: LearnerJudgment['ability'] = entry
    ? { kind: 'available', reading: entry }
    : mastery.kind === 'unknown'
      ? mastery
      : unknown('missing_mastery_state');
  // Keep inferred/zero-evidence source readings inspectable, without presenting
  // a population prior or a KG neighbour as this learner's observed success rate.
  const pfa: LearnerJudgment['p_correct_now'] =
    entry?.provenance === 'observed' && entry.evidence_count > 0
      ? {
          kind: 'incumbent_pfa',
          value: entry.mastery,
          band: {
            kind: 'incumbent_mastery_band',
            lo: entry.mastery_lo,
            hi: entry.mastery_hi,
          },
          calibration: 'uncalibrated',
        }
      : unknown(entry?.provenance === 'inferred' ? 'inferred_only' : 'insufficient_evidence');
  // A present New card's zero is preserved; an absent row remains unknown.
  // Structured candidate readings retain their kind/reason/calibration/provenance.
  // Role-gated non-kc ids never reach the retention read at all (YUK-1600).
  const itemRetention: LearnerJudgment['retention'] = nonKcIds.has(id)
    ? unknown('knowledge_role_not_mastery_evaluable')
    : memory !== undefined
      ? {
          kind: 'available',
          engine:
            typeof memory === 'number'
              ? 'fsrs'
              : memory.kind === 'score'
                ? 'forgetting_candidate'
                : 'unknown',
          reading: memory,
        }
      : retention.kind === 'unknown'
        ? retention
        : unknown('missing_scheduling_state');
  const effectivePfa = ability.kind === 'unknown' ? ability : pfa;
  const claim = abilityClaim(effectivePfa, nonKcIds.has(id));
  const age = evidenceAge(claim, entry, asOf);
  const disagreement = componentDisagreement(effectivePfa, itemRetention);
  return {
    knowledge_id: id,
    ability,
    p_correct_now: effectivePfa,
    ability_claim: claim,
    retention: itemRetention,
    retention_forecast: unknown('incumbent_port_exposes_current_retention_only'),
    uncertainty: {
      independent_evidence: unknown('incumbent_evidence_not_split_by_independence'),
      helped_evidence: unknown('incumbent_evidence_not_split_by_help'),
      self_rated_evidence: unknown('incumbent_evidence_not_split_by_source'),
      component_disagreement: disagreement,
      evidence_age: age,
    },
    would_change_it: unknown('information_gain_policy_not_available'),
    patterns: unknown('pattern_component_not_connected'),
    corrections: unknown('correction_reconciliation_not_connected'),
    judgement: judgementSentence(claim, itemRetention, disagreement, age),
  };
}

/**
 * Evidenced ability only, failing closed when the ability component did not
 * answer. Insufficient evidence, inferred-only neighbours, and roles that are
 * not mastery-evaluable are omitted: a missing key is not a cold-start low
 * score. The raw reading stays on the item.
 */
export function abilityReadingsByIdOrFail(
  batch: LearnerJudgmentBatch,
): Map<string, MasteryProjection> {
  for (const item of batch.items) {
    if (item.ability.kind === 'unknown' && isComponentFailureReason(item.ability.reason)) {
      throw new Error(`learner-judgment ability component failed: ${item.ability.reason}`);
    }
    if (item.ability_claim.kind === 'unavailable') {
      throw new Error(`learner-judgment ability component failed: ${item.ability_claim.reason}`);
    }
  }
  const byId = new Map<string, MasteryProjection>();
  for (const item of batch.items) {
    if (item.ability_claim.kind !== 'low_observed' && item.ability_claim.kind !== 'observed') {
      continue;
    }
    if (item.ability.kind !== 'available') continue;
    byId.set(item.knowledge_id, item.ability.reading);
  }
  return byId;
}

/**
 * One batch identity, one evaluation time, two incumbent owners. No fused P,
 * new model, write, issuance or provider call. A new Db transaction establishes
 * a read-only repeatable snapshot; an existing Tx must already provide one.
 */
export async function readLearnerJudgments(
  db: DbLike,
  input: LearnerJudgmentInput,
  // Preserve the existing Copilot mastery-reader injection. This is an explicit
  // partial source override: no DB access or fictitious retention/snapshot is
  // added to an injected read. Production supplies no override.
  deps: { getMasteryProjectionFn?: MasteryReader } = {},
): Promise<LearnerJudgmentBatch> {
  const parsed = LearnerJudgmentInputSchema.parse(input);
  const ids = [...new Set(parsed.knowledge_ids)];
  const asOf = new Date(parsed.as_of.getTime());
  const batch: LearnerJudgmentBatch = {
    version: 'v0-incumbent',
    calibration: 'uncalibrated',
    context: parsed.context,
    as_of: asOf,
    consistency: unknown('snapshot_not_established'),
    components: {
      ability: {
        source: 'kernel/read-models/mastery-projection:getMasteryProjection',
        version: unknown('incumbent_port_does_not_expose_component_version'),
        input_high_water: unknown('incumbent_port_does_not_expose_input_high_water'),
      },
      retention: {
        source: 'kernel/scheduling:getFsrsRetrievabilityByIds',
        selected_engine: unknown('engine_not_read'),
        version: unknown('incumbent_port_does_not_expose_component_version'),
        input_high_water: unknown('incumbent_port_does_not_expose_input_high_water'),
      },
    },
    input_high_water: unknown('incumbent_ports_do_not_expose_complete_input_high_water'),
    calibration_evidence: unknown('sealed_outcome_pairs_not_connected'),
    sealing: 'not_connected',
    items: [],
  };
  const unavailable = (reason: string) => {
    batch.items = ids.map((id) => judgment(id, unknown(reason), unknown(reason), asOf));
    return batch;
  };
  if (ids.length === 0) return batch;

  const injectedMastery = deps.getMasteryProjectionFn;
  if (injectedMastery) {
    batch.consistency = unknown('injected_partial_source');
    batch.components.ability.version = unknown('injected_source');
    let mastery: ComponentRead<MasteryProjection>;
    try {
      mastery = { kind: 'available', values: await injectedMastery(db, ids) };
    } catch {
      mastery = unknown('mastery_component_unavailable');
    }
    batch.items = ids.map((id) =>
      judgment(id, mastery, unknown('retention_source_not_injected'), asOf),
    );
    return batch;
  }

  try {
    batch.components.retention.selected_engine = {
      kind: 'selected',
      engine: selectedForgettingEngine(),
    };
  } catch {
    batch.components.retention.selected_engine = unknown('engine_selection_unavailable');
  }

  const readSnapshot = async (tx: Tx): Promise<LearnerJudgmentBatch> => {
    // Isolate errors with savepoints so a failed component query does not abort
    // the other component's read. Reads are sequential on the same connection.
    let mastery: ComponentRead<MasteryProjection>;
    try {
      mastery = {
        kind: 'available',
        values: await tx.transaction((part) => getMasteryProjection(part, ids)),
      };
    } catch {
      mastery = unknown('mastery_component_unavailable');
    }
    let retention: ComponentRead<RetentionReading>;
    let nonKcIds: ReadonlySet<string> = new Set();
    if (batch.components.retention.selected_engine.kind === 'unknown') {
      retention = unknown('engine_selection_unavailable');
    } else {
      try {
        retention = {
          kind: 'available',
          values: await tx.transaction(async (part) => {
            // YUK-1600: retention is a mastery-family reading, so goal/container
            // roots never read FSRS R(t), even where pre-gate stock rows exist.
            nonKcIds = await getNonKcKnowledgeIds(part, ids);
            return getFsrsRetrievabilityByIds(
              part,
              'knowledge',
              ids.filter((id) => !nonKcIds.has(id)),
              asOf,
            );
          }),
        };
      } catch {
        retention = unknown('retention_component_unavailable');
      }
    }
    batch.items = ids.map((id) => judgment(id, mastery, retention, asOf, nonKcIds));
    return batch;
  };

  try {
    if ('$client' in db) {
      const result = await db.transaction(readSnapshot, {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
      result.consistency = {
        kind: 'snapshot',
        isolation: 'repeatable read',
        access: 'read only',
      };
      return result;
    }
    // A savepoint cannot upgrade its parent's snapshot or access mode. Do not
    // silently label a caller's read-committed/write transaction as a snapshot.
    const settings = await db.execute<{ isolation: string; read_only: string }>(sql`
      select current_setting('transaction_isolation') as isolation,
             current_setting('transaction_read_only') as read_only
    `);
    const setting = settings[0];
    if (
      setting?.read_only !== 'on' ||
      (setting.isolation !== 'repeatable read' && setting.isolation !== 'serializable')
    ) {
      return unavailable('caller_transaction_is_not_a_read_only_snapshot');
    }
    await readSnapshot(db);
    batch.consistency = {
      kind: 'snapshot',
      isolation: setting.isolation,
      access: 'read only',
    };
    return batch;
  } catch {
    batch.consistency = unknown('snapshot_unavailable');
    return unavailable('snapshot_unavailable');
  }
}

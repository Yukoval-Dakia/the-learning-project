import { sql } from 'drizzle-orm';
import {
  COMPONENT_DISAGREEMENT_RULE,
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

// Deterministic plain-language sentence covering 会做 / 记得 / 分歧. Qualitative
// only: no numbers reach learner-visible surfaces before the D6 threshold.
function judgementSentence(
  pfa: LearnerJudgment['p_correct_now'],
  retention: LearnerJudgment['retention'],
  disagreement: LearnerJudgment['uncertainty']['component_disagreement'],
): string {
  const canDo =
    pfa.kind === 'incumbent_pfa'
      ? '会做：现役掌握读数可用，尚未个人校准'
      : pfa.reason === 'inferred_only'
        ? '会做：仅知识关联推断，还不知道'
        : '会做：本人作答证据不足，还不知道';
  const remember =
    retentionValue(retention) !== null
      ? '记得：现役保持读数可用，尚未个人校准'
      : '记得：暂无保持读数，还不知道';
  const divergence =
    disagreement.kind === 'divergence_observed'
      ? disagreement.direction === 'ability_high_retention_low'
        ? '分歧：会做读数高而保持读数低（可能会了但快忘）'
        : '分歧：保持读数高而会做读数低（可能记得但不会用）'
      : disagreement.kind === 'no_divergence_observed'
        ? '分歧：两读数同向，未见背离'
        : disagreement.kind === 'partial_coverage'
          ? '分歧：仅一端读数可用，暂无法判断'
          : '分歧：两端读数均不可用，还不知道';
  return `${canDo}；${remember}；${divergence}。`;
}

function judgment(
  id: string,
  mastery: ComponentRead<MasteryProjection>,
  retention: ComponentRead<RetentionReading>,
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
  const disagreement = componentDisagreement(effectivePfa, itemRetention);
  return {
    knowledge_id: id,
    ability,
    p_correct_now: effectivePfa,
    retention: itemRetention,
    retention_forecast: unknown('incumbent_port_exposes_current_retention_only'),
    uncertainty: {
      independent_evidence: unknown('incumbent_evidence_not_split_by_independence'),
      helped_evidence: unknown('incumbent_evidence_not_split_by_help'),
      self_rated_evidence: unknown('incumbent_evidence_not_split_by_source'),
      component_disagreement: disagreement,
    },
    would_change_it: unknown('information_gain_policy_not_available'),
    patterns: unknown('pattern_component_not_connected'),
    corrections: unknown('correction_reconciliation_not_connected'),
    judgement: judgementSentence(effectivePfa, itemRetention, disagreement),
  };
}

/**
 * Fold a batch's ability readings back into the incumbent projection map shape
 * (observed + inferred entries), so consumers previously holding a
 * getMasteryProjection map adopt the contract without re-deriving fields.
 */
export function abilityReadingsById(batch: LearnerJudgmentBatch): Map<string, MasteryProjection> {
  const byId = new Map<string, MasteryProjection>();
  for (const item of batch.items) {
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
    batch.items = ids.map((id) => judgment(id, unknown(reason), unknown(reason)));
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
    batch.items = ids.map((id) => judgment(id, mastery, unknown('retention_source_not_injected')));
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
    batch.items = ids.map((id) => judgment(id, mastery, retention, nonKcIds));
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

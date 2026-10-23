import { sql } from 'drizzle-orm';
import {
  type JudgmentUnknown,
  type LearnerJudgment,
  type LearnerJudgmentBatch,
  type LearnerJudgmentInput,
  LearnerJudgmentInputSchema,
} from '@/core/schema/learner-judgment';
import type { RetentionReading } from '@/core/schema/scheduling-state';
import type { Db, Tx } from '@/db/client';
import { getFsrsRetrievabilityByIds, selectedForgettingEngine } from '@/kernel/scheduling';
import { type MasteryProjection, getMasteryProjection } from './mastery-projection';

type DbLike = Db | Tx;
type MasteryReader = (db: DbLike, ids: string[]) => Promise<Map<string, MasteryProjection>>;
type ComponentRead<T> = { kind: 'available'; values: Map<string, T> } | JudgmentUnknown;

function unknown(reason: string): JudgmentUnknown {
  return { kind: 'unknown', reason };
}

function judgment(
  id: string,
  mastery: ComponentRead<MasteryProjection>,
  retention: ComponentRead<RetentionReading>,
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
  return {
    knowledge_id: id,
    ability,
    p_correct_now: ability.kind === 'unknown' ? ability : pfa,
    // A present New card's zero is preserved; an absent row remains unknown.
    // Structured candidate readings retain their kind/reason/calibration/provenance.
    retention:
      memory !== undefined
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
          : unknown('missing_scheduling_state'),
    retention_forecast: unknown('incumbent_port_exposes_current_retention_only'),
    uncertainty: {
      independent_evidence: unknown('incumbent_evidence_not_split_by_independence'),
      helped_evidence: unknown('incumbent_evidence_not_split_by_help'),
      self_rated_evidence: unknown('incumbent_evidence_not_split_by_source'),
      component_disagreement: unknown('components_are_not_a_joint_prediction'),
    },
    would_change_it: unknown('information_gain_policy_not_available'),
    patterns: unknown('pattern_component_not_connected'),
    corrections: unknown('correction_reconciliation_not_connected'),
    judgement:
      pfa.kind === 'incumbent_pfa'
        ? '现役 PFA 掌握度读数，尚未个人校准；不是已校准的独立作答预测。'
        : entry?.provenance === 'inferred'
          ? '仅有知识关联推断，尚无足够本人作答证据。'
          : '本人作答证据不足或部件不可用，暂不知道。',
  };
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
    if (batch.components.retention.selected_engine.kind === 'unknown') {
      retention = unknown('engine_selection_unavailable');
    } else {
      try {
        retention = {
          kind: 'available',
          values: await tx.transaction((part) =>
            getFsrsRetrievabilityByIds(part, 'knowledge', ids, asOf),
          ),
        };
      } catch {
        retention = unknown('retention_component_unavailable');
      }
    }
    batch.items = ids.map((id) => judgment(id, mastery, retention));
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

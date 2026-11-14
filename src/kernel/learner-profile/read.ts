// Read-only learner-profile getter. One repeatable-read snapshot: rows that are
// current return their stored projection; rows with pending intents are stale,
// so the getter rebuilds the same canonical LearnerJudgment inside the same
// snapshot and reports freshness metadata. It never writes a row or an intent,
// and never returns an unrefreshed row as current.

import { and, inArray, isNull, sql } from 'drizzle-orm';
import type { LearnerJudgment, LearnerJudgmentBatch } from '@/core/schema/learner-judgment';
import type { Db, Tx } from '@/db/client';
import { learner_profile, learner_profile_refresh_intent } from '@/db/schema';
import { buildProfileJudgments, loadCanonicalProfileInputs } from './build';

type DbLike = Db | Tx;

export type ProfileFreshness =
  | { kind: 'current'; profile_version: number; built_at: Date }
  | { kind: 'stale'; pending_intent_ids: string[] }
  | { kind: 'missing' };

export interface LearnerProfileRead {
  knowledge_id: string;
  freshness: ProfileFreshness;
  judgment: LearnerJudgment;
}

async function pendingIntentIdsByKc(tx: Tx, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      id: learner_profile_refresh_intent.id,
      kc: learner_profile_refresh_intent.knowledge_id,
    })
    .from(learner_profile_refresh_intent)
    .where(
      and(
        inArray(learner_profile_refresh_intent.knowledge_id, ids),
        isNull(learner_profile_refresh_intent.consumed_at),
      ),
    );
  for (const row of rows) {
    const list = out.get(row.kc) ?? [];
    list.push(row.id);
    out.set(row.kc, list);
  }
  return out;
}

/**
 * Batch read. `db` may be a Db (opens a repeatable-read, read-only tx) or a Tx
 * that is already a read-only snapshot (same contract as readLearnerJudgments).
 */
export async function readLearnerProfiles(
  db: DbLike,
  input: { knowledge_ids: string[]; as_of: Date },
): Promise<{ as_of: Date; items: LearnerProfileRead[] }> {
  const ids = [
    ...new Set(input.knowledge_ids.map((id) => id.trim()).filter((id) => id.length > 0)),
  ];
  const asOf = new Date(input.as_of.getTime());
  if (ids.length === 0) return { as_of: asOf, items: [] };

  const run = async (tx: Tx): Promise<LearnerProfileRead[]> => {
    const [rows, pendingByKc] = await Promise.all([
      tx.select().from(learner_profile).where(inArray(learner_profile.knowledge_id, ids)),
      pendingIntentIdsByKc(tx, ids),
    ]);
    const rowByKc = new Map(rows.map((row) => [row.knowledge_id, row]));
    // Rebuild stale or missing rows in the same snapshot from canonical inputs.
    const staleIds = ids.filter((id) => {
      const row = rowByKc.get(id);
      const pending = pendingByKc.get(id);
      return !row || (pending !== undefined && pending.length > 0);
    });
    const rebuilt = new Map<string, LearnerJudgment>();
    if (staleIds.length > 0) {
      const inputs = await loadCanonicalProfileInputs(tx, staleIds, asOf);
      for (const judgment of buildProfileJudgments(staleIds, inputs, asOf)) {
        rebuilt.set(judgment.knowledge_id, judgment);
      }
    }
    return ids.map((id) => {
      const row = rowByKc.get(id);
      const pending = pendingByKc.get(id);
      const stale = !row || (pending !== undefined && pending.length > 0);
      if (stale) {
        return {
          knowledge_id: id,
          freshness: !row
            ? ({ kind: 'missing' } as const)
            : ({ kind: 'stale', pending_intent_ids: pending ?? [] } as const),
          judgment: rebuilt.get(id) as LearnerJudgment,
        };
      }
      return {
        knowledge_id: id,
        freshness: {
          kind: 'current',
          profile_version: row.profile_version,
          built_at: row.built_at,
        },
        judgment: rowToJudgment(row),
      };
    });
  };

  if ('$client' in db) {
    const items = await db.transaction(run, {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    return { as_of: asOf, items };
  }
  // A savepoint cannot upgrade its parent's snapshot or access mode; refuse a
  // caller tx that is not already a read-only repeatable/serializable snapshot.
  const settings = await db.execute<{ isolation: string; read_only: string }>(sql`
    select current_setting('transaction_isolation') as isolation,
           current_setting('transaction_read_only') as read_only
  `);
  const setting = settings[0];
  if (
    setting?.read_only !== 'on' ||
    (setting.isolation !== 'repeatable read' && setting.isolation !== 'serializable')
  ) {
    // Not a snapshot: every item reports unavailable rather than a mislabeled read.
    const failed: LearnerProfileRead[] = ids.map((id) => ({
      knowledge_id: id,
      freshness: { kind: 'missing' },
      judgment: {
        knowledge_id: id,
        ability: { kind: 'unknown', reason: 'caller_transaction_is_not_a_read_only_snapshot' },
        p_correct_now: {
          kind: 'unknown',
          reason: 'caller_transaction_is_not_a_read_only_snapshot',
        },
        ability_claim: {
          kind: 'unavailable',
          reason: 'caller_transaction_is_not_a_read_only_snapshot',
        },
        retention: { kind: 'unknown', reason: 'caller_transaction_is_not_a_read_only_snapshot' },
        evidence_timing: { last_outcome_at: null, last_activity_at: null },
        review_timing: {
          recall: { kind: 'unknown', reason: 'caller_transaction_is_not_a_read_only_snapshot' },
          basis: {
            last_retrieval_at: {
              kind: 'unknown',
              reason: 'caller_transaction_is_not_a_read_only_snapshot',
            },
            duration_ms: {
              kind: 'unknown',
              reason: 'caller_transaction_is_not_a_read_only_snapshot',
            },
          },
          freshness: {
            decay_bucket: 'unknown',
            due_at: { kind: 'unknown', reason: 'caller_transaction_is_not_a_read_only_snapshot' },
            mastered_shelf: { kind: 'not_high' },
          },
        },
        retention_forecast: {
          kind: 'unknown',
          reason: 'caller_transaction_is_not_a_read_only_snapshot',
        },
        uncertainty: {
          independent_evidence: {
            kind: 'unknown',
            reason: 'incumbent_evidence_not_split_by_independence',
          },
          helped_evidence: { kind: 'unknown', reason: 'incumbent_evidence_not_split_by_help' },
          self_rated_evidence: {
            kind: 'unknown',
            reason: 'incumbent_evidence_not_split_by_source',
          },
          component_disagreement: {
            kind: 'unknown',
            reason: 'caller_transaction_is_not_a_read_only_snapshot',
          },
          evidence_age: {
            kind: 'not_applicable',
            reason: 'caller_transaction_is_not_a_read_only_snapshot',
          },
        },
        would_change_it: { kind: 'unknown', reason: 'information_gain_policy_not_available' },
        patterns: { kind: 'unknown', reason: 'pattern_component_not_connected' },
        corrections: { kind: 'unknown', reason: 'correction_reconciliation_not_connected' },
        judgement: '会做：掌握部件不可用，读取失败；记得：保持部件不可用，读取失败。',
      } as LearnerJudgment,
    }));
    return { as_of: asOf, items: failed };
  }
  const items = await run(db);
  return { as_of: asOf, items };
}

type ProfileRow = typeof learner_profile.$inferSelect;

function rowToJudgment(row: ProfileRow): LearnerJudgment {
  return {
    knowledge_id: row.knowledge_id,
    ability: row.ability as LearnerJudgment['ability'],
    p_correct_now: row.p_correct_now as LearnerJudgment['p_correct_now'],
    ability_claim: row.ability_claim as LearnerJudgment['ability_claim'],
    retention: row.retention as LearnerJudgment['retention'],
    evidence_timing: row.evidence_timing as LearnerJudgment['evidence_timing'],
    review_timing: row.review_timing as unknown as LearnerJudgment['review_timing'],
    retention_forecast: row.retention_forecast as LearnerJudgment['retention_forecast'],
    uncertainty: row.uncertainty as LearnerJudgment['uncertainty'],
    would_change_it: row.would_change_it as LearnerJudgment['would_change_it'],
    patterns: row.patterns as LearnerJudgment['patterns'],
    corrections: row.corrections as LearnerJudgment['corrections'],
    judgement: row.judgement ?? '',
  };
}

/**
 * Compat view for consumers that already speak LearnerJudgmentBatch. The items
 * come from profile rows (current) or same-snapshot rebuilds (stale/missing) —
// same numbers, with per-item freshness provenance attached.
 */
export async function readLearnerProfilesAsBatch(
  db: DbLike,
  input: { knowledge_ids: string[]; as_of: Date; context: 'any' },
): Promise<LearnerJudgmentBatch & { profile_freshness: Map<string, ProfileFreshness> }> {
  const result = await readLearnerProfiles(db, {
    knowledge_ids: input.knowledge_ids,
    as_of: input.as_of,
  });
  const profile_freshness = new Map<string, ProfileFreshness>();
  for (const item of result.items) profile_freshness.set(item.knowledge_id, item.freshness);
  const stale = result.items.some((item) => item.freshness.kind !== 'current');
  const batch: LearnerJudgmentBatch & { profile_freshness: Map<string, ProfileFreshness> } = {
    version: 'v0-incumbent',
    calibration: 'uncalibrated',
    context: input.context,
    as_of: result.as_of,
    consistency: {
      kind: 'snapshot',
      isolation: 'repeatable read',
      access: 'read only',
    },
    components: {
      ability: {
        source: 'kernel/read-models/mastery-projection:getMasteryProjection',
        version: { kind: 'unknown', reason: 'incumbent_port_does_not_expose_component_version' },
        input_high_water: {
          kind: 'unknown',
          reason: 'incumbent_port_does_not_expose_input_high_water',
        },
      },
      retention: {
        source: 'kernel/scheduling:retrievabilityForKc',
        selected_engine: { kind: 'unknown', reason: 'engine_not_read' },
        version: { kind: 'unknown', reason: 'incumbent_port_does_not_expose_component_version' },
        input_high_water: {
          kind: 'unknown',
          reason: 'incumbent_port_does_not_expose_input_high_water',
        },
      },
    },
    input_high_water: {
      kind: 'unknown',
      reason: 'incumbent_ports_do_not_expose_complete_input_high_water',
    },
    calibration_evidence: { kind: 'unknown', reason: 'sealed_outcome_pairs_not_connected' },
    sealing: 'not_connected',
    items: result.items.map((item) => item.judgment),
    profile_freshness,
  };
  if (stale) {
    batch.consistency = {
      kind: 'snapshot',
      isolation: 'repeatable read',
      access: 'read only',
    };
  }
  return batch;
}

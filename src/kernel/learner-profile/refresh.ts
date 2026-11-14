// Worker drain for learner-profile refresh. Serial: global learning-state lock
// G first, then per-KC profile locks in stable order, then a per-KC
// profile_version CAS write with the intents this snapshot consumed committed
// in the same transaction. Pending intents — never MAX(event_id)/created_at —
// decide freshness, so a late-committing intent is picked up rather than
// skipped. A failed refresh leaves the intent unconsumed and retryable; it
// never touches canonical learning facts.
//
// Lock order: G → learner_profile:knowledge:<kc> (ascending). Settlement takes
// G then fsrs:knowledge:<kc>; a profile refresh never takes fsrs:* or mastery:*
// locks, so the two hierarchies cannot deadlock (G serializes them anyway).

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { LearnerJudgment } from '@/core/schema/learner-judgment';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { learner_profile, learner_profile_refresh_intent } from '@/db/schema';
import { lockLearnerProfileKnowledge } from '@/kernel/locks/learner-profile';
import { reviewTimingJson } from '@/kernel/read-models/review-timing';
import { buildProfileJudgments, loadCanonicalProfileInputs, persistedStateForKc } from './build';

const DRAIN_LIMIT = 200;

function jsonForColumn(item: LearnerJudgment) {
  return {
    ability: item.ability,
    p_correct_now: item.p_correct_now,
    retention: item.retention,
    evidence_timing: item.evidence_timing,
    review_timing: reviewTimingJson(item.review_timing),
    ability_claim: item.ability_claim,
    uncertainty: item.uncertainty,
    would_change_it: item.would_change_it,
    patterns: item.patterns,
    corrections: item.corrections,
    retention_forecast: item.retention_forecast,
    judgement: item.judgement,
  };
}

type PendingIntent = {
  id: string;
  knowledge_id: string;
  seq: number;
};

async function pendingIntents(tx: Tx, limit: number): Promise<PendingIntent[]> {
  return tx
    .select({
      id: learner_profile_refresh_intent.id,
      knowledge_id: learner_profile_refresh_intent.knowledge_id,
      seq: learner_profile_refresh_intent.seq,
    })
    .from(learner_profile_refresh_intent)
    .where(isNull(learner_profile_refresh_intent.consumed_at))
    .orderBy(learner_profile_refresh_intent.seq)
    .limit(limit);
}

/**
 * Refresh a bounded batch of KC profile rows from pending intents.
 * Opens one transaction that holds G for the whole drain; per-KC locks and CAS
 * writes happen inside it, so intent consumption and the row write are atomic.
 */
export async function drainLearnerProfileRefresh(db: Db): Promise<{ refreshed: number }> {
  return db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    const pending = await pendingIntents(tx, DRAIN_LIMIT);
    if (pending.length === 0) return { refreshed: 0 };

    const knowledgeIds = [...new Set(pending.map((row) => row.knowledge_id))].sort();
    for (const kc of knowledgeIds) await lockLearnerProfileKnowledge(tx, kc);

    const intentsByKc = new Map<string, PendingIntent[]>();
    for (const row of pending) {
      const list = intentsByKc.get(row.knowledge_id) ?? [];
      list.push(row);
      intentsByKc.set(row.knowledge_id, list);
    }

    const asOf = new Date();
    // Strict mode: an operational component failure rolls back the whole
    // drain — pending intents stay retryable instead of being consumed under a
    // degraded UNKNOWN row. Legitimate missing evidence stays a named unknown.
    const inputs = await loadCanonicalProfileInputs(tx, knowledgeIds, asOf, { mode: 'throw' });
    const judgments = buildProfileJudgments(knowledgeIds, inputs, asOf);
    let refreshed = 0;

    for (const item of judgments) {
      const consumed = (intentsByKc.get(item.knowledge_id) ?? []).map((row) => row.id);
      const payload = jsonForColumn(item);
      const componentVersions = {
        ability: { source: 'kernel/read-models/mastery-projection:getMasteryProjection' },
        retention: { source: 'kernel/scheduling:retrievabilityForKc' },
        engine: inputs.selectedEngine,
      };
      const [existing] = await tx
        .select({ id: learner_profile.id, profile_version: learner_profile.profile_version })
        .from(learner_profile)
        .where(eq(learner_profile.knowledge_id, item.knowledge_id));

      if (!existing) {
        await tx.insert(learner_profile).values({
          id: `lp_${createId()}`,
          knowledge_id: item.knowledge_id,
          profile_version: 1,
          built_at: asOf,
          consumed_intent_ids: consumed,
          ...payload,
          canonical_state: persistedStateForKc(item.knowledge_id, inputs) as unknown as Record<
            string,
            unknown
          >,
          component_versions: componentVersions,
        });
      } else {
        // CAS on profile_version; the per-KC advisory lock already serialized
        // writers, so the version check is a defensive invariant.
        await tx
          .update(learner_profile)
          .set({
            profile_version: existing.profile_version + 1,
            built_at: asOf,
            consumed_intent_ids: consumed,
            ...payload,
            canonical_state: persistedStateForKc(item.knowledge_id, inputs) as unknown as Record<
              string,
              unknown
            >,
            component_versions: componentVersions,
            updated_at: asOf,
          })
          .where(
            and(
              eq(learner_profile.id, existing.id),
              eq(learner_profile.profile_version, existing.profile_version),
            ),
          );
      }
      refreshed += 1;
    }

    // Consume only the intents this drain actually refreshed, inside the same
    // transaction so consumption is atomic with the row writes.
    await tx
      .update(learner_profile_refresh_intent)
      .set({ consumed_at: asOf })
      .where(
        inArray(
          learner_profile_refresh_intent.id,
          pending.map((row) => row.id),
        ),
      );

    return { refreshed };
  });
}

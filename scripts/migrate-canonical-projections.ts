import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, materialized_id_index } from '@/db/schema';
import { auditProjectionKind, auditProjectionKindSymmetric } from '@/server/projections/audit-kind';
import { PROJECTION_ENTITIES } from '@/server/projections/entity-registry';
import {
  backfillGoalGenesis,
  backfillLearningItemGenesis,
  backfillMistakeVariantGenesis,
} from './backfill-genesis-events';

const BACKFILLS = {
  goal: backfillGoalGenesis,
  mistake_variant: backfillMistakeVariantGenesis,
  learning_item: backfillLearningItemGenesis,
} as const;

/** Deployment-only preparation for the canonical structural writers, never a live rebuild.
 * Snapshot only eventless legacy rows; an incomplete history requires explicit repair.
 * All anchors roll back together if any kind fails the independent fold/live audit.
 */
export async function migrateCanonicalProjections(db: Db, now = new Date()) {
  return db.transaction(async (tx) => {
    // Serialize concurrent migration runs and prevent an old writer changing the snapshot
    // between classification and audit. Run with application writers stopped; fail promptly
    // instead of holding up an active learner transaction indefinitely.
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`LOCK TABLE event, materialized_id_index, goal, mistake_variant,
      learning_item IN SHARE ROW EXCLUSIVE MODE`);

    const report: Record<string, { seeded: number; skipped: number; checked: number }> = {};
    for (const kind of Object.keys(BACKFILLS) as (keyof typeof BACKFILLS)[]) {
      const adapter = PROJECTION_ENTITIES[kind];
      // An index is a reference, not proof that its originating event survived.
      // Check even IDs without a live row: symmetric null/null parity cannot detect
      // a dangling reference. Retraction keeps the originating event and remains valid.
      const anchors = await tx
        .select({ id: materialized_id_index.materialized_id, origin: event })
        .from(materialized_id_index)
        .leftJoin(event, eq(event.id, materialized_id_index.anchor_event_id))
        .where(eq(materialized_id_index.subject_kind, kind));
      for (const anchor of anchors) {
        if (!anchor.origin) {
          throw new Error(
            `[canonical-projections] ${kind}: missing originating event for ${anchor.id}`,
          );
        }
        if (anchor.origin.subject_kind !== kind || anchor.origin.subject_id !== anchor.id) {
          throw new Error(
            `[canonical-projections] ${kind}: mismatched originating event for ${anchor.id}`,
          );
        }
      }
      const ids = [...(await adapter.liveIds(tx))];
      const liveIds = new Set(ids);
      const absent = anchors.filter((anchor) => !liveIds.has(anchor.id));
      if (absent.length > 0) {
        const { foldOne } = await adapter.gatherWithContext(tx);
        for (const anchor of absent) {
          // These three folds retain dormant/dismissed/archived tombstones on
          // retraction; null means no reconstructible base, not a valid deletion.
          if ((await foldOne(anchor.id)) === null) {
            throw new Error(
              `[canonical-projections] ${kind}: unreconstructible originating history for ${anchor.id}`,
            );
          }
        }
      }
      const anchored = await adapter.withGenesisAnchor(tx, ids);
      const eventful = await adapter.eventSubjectIds(tx);
      const incomplete = ids.filter((id) => !anchored.has(id) && eventful.has(id));
      if (incomplete.length > 0) {
        throw new Error(
          `[canonical-projections] ${kind}: history without a base anchor (${incomplete.slice(0, 10).join(', ')}); repair history before retrying migration`,
        );
      }
      const counts = await BACKFILLS[kind](tx, now);
      const audit = await auditProjectionKind(tx, kind);
      // Include event-only entities too: value parity on live rows alone misses a
      // deleted live row that the next projection write would resurrect. Table locks
      // keep these reads on the same state without a live rebuild.
      const symmetric = await auditProjectionKindSymmetric(tx, kind);
      if (audit.drift.length > 0 || symmetric.length > 0) {
        const ids = [...new Set([...audit.drift, ...symmetric].map((row) => row.id))];
        throw new Error(
          `[canonical-projections] ${kind}: fold/live drift (${ids.slice(0, 10).join(', ')}); no genesis changes committed`,
        );
      }
      report[kind] = { ...counts, checked: audit.checked };
    }
    return report;
  });
}

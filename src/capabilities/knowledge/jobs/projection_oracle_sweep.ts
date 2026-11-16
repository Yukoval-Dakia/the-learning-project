// Weekly report-only projection-drift sweep. Re-folding the live gather cannot prove a
// reducer correct, but it can detect out-of-band value changes on anchored rows and
// rowset gaps: a log-implied row that is not live (ghost), or a live anchored row that
// folds to null (missing).
//
// Only the symmetric anchored audit runs. The unfiltered auditor would flag every
// pre-event-sourced row on live data.
//
// Report-only: anomalies are structured logs. The sweep never writes events or
// entity rows. The whole run is one repeatable-read snapshot so a concurrent
// write cannot fabricate drift. It audits only entities whose writer flag is on,
// and never auto-repairs: letting the fold win would silently flip the source of truth.

import type { Job } from 'pg-boss';

import type { Db, Tx } from '@/db/client';
import { projectionIsWriter } from '@/kernel/projection-writer-policy';
import {
  type ProjectionAllowlist,
  type SymmetricRecord,
  auditProjectionKindSymmetric,
} from '@/server/projections/audit-kind';
import {
  ALL_PROJECTION_KINDS,
  PROJECTION_ENTITIES,
  type ProjectionKind,
} from '@/server/projections/entity-registry';

export interface ProjectionOracleReport {
  auditedKinds: ProjectionKind[];
  /** Writer flag off; the imperative path still owns the entity. */
  skippedKinds: ProjectionKind[];
  anomalies: number;
  ghost: number;
  missing: number;
  fieldDrift: number;
}

export interface RunProjectionOracleSweepOpts {
  allowlist?: ProjectionAllowlist;
  /** Test-only seam after the census read, inside the repeatable-read snapshot. */
  onAfterCensus?: (tx: Tx) => Promise<void>;
}

/** Whether the entity's source-of-truth writer flag is on. */
function isTrackedWriter(kind: ProjectionKind): boolean {
  return projectionIsWriter(PROJECTION_ENTITIES[kind].flagEntity);
}

// Log only diverged field names and counts, never user content.
function logAnomaly(rec: SymmetricRecord): void {
  console.warn('[projection-parity] oracle anomaly', {
    subject_kind: rec.kind,
    id: rec.id,
    verdict: rec.verdict,
    diff_fields: rec.diffs.map((line) => line.split(':', 1)[0] ?? line),
    diff_count: rec.diffs.length,
  });
}

/**
 * Audit every enabled kind in one repeatable-read transaction and log anomalies.
 * Never writes an entity or repairs. Only DB failures throw.
 */
export async function runProjectionOracleSweep(
  db: Db,
  opts: RunProjectionOracleSweepOpts = {},
): Promise<ProjectionOracleReport> {
  const allowlist = opts.allowlist ?? {};

  return db.transaction(
    async (tx) => {
      const auditedKinds: ProjectionKind[] = [];
      const skippedKinds: ProjectionKind[] = [];
      const anomalies: SymmetricRecord[] = [];

      for (const kind of ALL_PROJECTION_KINDS) {
        if (!isTrackedWriter(kind)) {
          skippedKinds.push(kind);
          continue;
        }
        auditedKinds.push(kind);
        const recs = await auditProjectionKindSymmetric(tx, kind, allowlist);
        anomalies.push(...recs);
      }

      // The census already captured the snapshot; a concurrent commit must not change it.
      await opts.onAfterCensus?.(tx);

      let ghost = 0;
      let missing = 0;
      let fieldDrift = 0;
      for (const rec of anomalies) {
        if (rec.verdict === 'GHOST') ghost += 1;
        else if (rec.verdict === 'MISSING') missing += 1;
        else fieldDrift += 1;
        logAnomaly(rec);
      }

      if (anomalies.length === 0) {
        console.log('[projection-parity] oracle CLEAN — no drift on the ON projection entities', {
          auditedKinds,
          skippedKinds,
        });
      } else {
        console.warn(
          `[projection-parity] oracle flagged ${anomalies.length} anomaly(ies) — REPORT-ONLY, no auto-repair`,
          { auditedKinds, ghost, missing, fieldDrift },
        );
      }

      return {
        auditedKinds,
        skippedKinds,
        anomalies: anomalies.length,
        ghost,
        missing,
        fieldDrift,
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}

/** Handler. Only a genuine DB failure throws, for pg-boss retry. */
export function buildProjectionOracleSweepHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const r = await runProjectionOracleSweep(db);
      console.log('[projection_oracle_sweep] done', r);
    } catch (err) {
      console.error('[projection_oracle_sweep] failed', err);
      throw err;
    }
  };
}

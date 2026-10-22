// Weekly report-only projection-drift sweep. Re-folding the live gather cannot prove a
// reducer correct, but it can detect out-of-band value changes on anchored rows and
// rowset gaps: a log-implied row that is not live (ghost), or a live anchored row that
// folds to null (missing).
//
// Only the symmetric anchored audit runs. The unfiltered auditor would flag every
// pre-event-sourced row on live data.
//
// Report-only: the sole write is a fold-inert forensic breadcrumb, one open record per
// row, so it cannot accumulate or scan itself. The whole run is one repeatable-read
// snapshot so a concurrent write cannot fabricate drift. It audits only entities whose
// writer flag is on, and never auto-repairs: letting the fold win would silently flip
// the source of truth.

import { and, eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
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
import { projectionIsWriter } from '@/server/projections/sot-flag';

// No gather scans this subject kind, so the breadcrumb is structurally fold-inert.
const ORACLE_FORENSIC_ACTION = 'experimental:projection_oracle_flagged';
const ORACLE_FORENSIC_SUBJECT_KIND = 'projection_oracle';

export interface ProjectionOracleReport {
  auditedKinds: ProjectionKind[];
  /** Writer flag off; the imperative path still owns the entity. */
  skippedKinds: ProjectionKind[];
  anomalies: number;
  ghost: number;
  missing: number;
  fieldDrift: number;
  forensicWritten: number;
}

export interface RunProjectionOracleSweepOpts {
  now?: Date;
  allowlist?: ProjectionAllowlist;
  /** Test-only seam between census and forensic writes, for snapshot isolation. */
  onBeforeForensic?: (tx: Tx) => Promise<void>;
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

// One breadcrumb per kind:id while a record is open, so accumulation stays bounded.
async function writeForensicOnce(db: Db | Tx, rec: SymmetricRecord, now: Date): Promise<boolean> {
  const forensicSubjectId = `${rec.kind}:${rec.id}`;
  // Include subject_kind so the lookup uses the composite event index.
  const existing = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, ORACLE_FORENSIC_ACTION),
        eq(event.subject_kind, ORACLE_FORENSIC_SUBJECT_KIND),
        eq(event.subject_id, forensicSubjectId),
      ),
    )
    .limit(1);
  if (existing.length > 0) return false;
  await writeEvent(db, {
    id: newId(),
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'projection_oracle_sweep',
    action: ORACLE_FORENSIC_ACTION,
    subject_kind: ORACLE_FORENSIC_SUBJECT_KIND,
    subject_id: forensicSubjectId,
    outcome: 'success',
    payload: {
      projection_kind: rec.kind,
      projection_id: rec.id,
      verdict: rec.verdict,
      diff_fields: rec.diffs.map((line) => line.split(':', 1)[0] ?? line),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    // Opt out of memory ingestion; this is not user activity.
    ingest_at: now,
  });
  return true;
}

/**
 * Audit every enabled kind in one repeatable-read transaction, log anomalies and write
 * one breadcrumb per row. Never writes an entity or repairs. Only DB failures throw.
 */
export async function runProjectionOracleSweep(
  db: Db,
  opts: RunProjectionOracleSweepOpts = {},
): Promise<ProjectionOracleReport> {
  const now = opts.now ?? new Date();
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
      await opts.onBeforeForensic?.(tx);

      let ghost = 0;
      let missing = 0;
      let fieldDrift = 0;
      let forensicWritten = 0;
      for (const rec of anomalies) {
        if (rec.verdict === 'GHOST') ghost += 1;
        else if (rec.verdict === 'MISSING') missing += 1;
        else fieldDrift += 1;
        logAnomaly(rec);
        if (await writeForensicOnce(tx, rec, now)) forensicWritten += 1;
      }

      if (anomalies.length === 0) {
        console.log('[projection-parity] oracle CLEAN — no drift on the ON projection entities', {
          auditedKinds,
          skippedKinds,
        });
      } else {
        console.warn(
          `[projection-parity] oracle flagged ${anomalies.length} anomaly(ies) — REPORT-ONLY, no auto-repair`,
          { auditedKinds, ghost, missing, fieldDrift, forensicWritten },
        );
      }

      return {
        auditedKinds,
        skippedKinds,
        anomalies: anomalies.length,
        ghost,
        missing,
        fieldDrift,
        forensicWritten,
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

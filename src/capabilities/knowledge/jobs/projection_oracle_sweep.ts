// YUK-548 (worklist #5, Q4a / component 5) — the CONTINUOUS projection-drift oracle: a weekly
// REPORT-ONLY sweep over the currently-ON projection entities.
//
// PURPOSE (spec §0, honest value proposition). For an entity already flipped ON, re-folding with the
// SAME gather the live path uses is tautologically self-consistent — it CANNOT prove reducer
// correctness. What it CAN detect is (a) out-of-band VALUE changes on anchored rows (a manual psql /
// migration / a writer that bypassed the projection), and (b) ROWSET existence anomalies (a row the
// log implies but is not live = GHOST; an anchored live row the log folds to null = MISSING). That is
// this sweep's real job. The register's "prove fold didn't drift after the flip" requirement is a
// DIFFERENT, non-tautological leg (Q4b retained-golden, scripts/golden-reaudit.ts) — NOT this.
//
// It uses ONLY the anchor-gated SYMMETRIC audit (auditProjectionKindSymmetric, component 4), which
// already yields FIELD_DRIFT (the §0 value-diff leg) + GHOST/MISSING (the §0 rowset leg) in one pass.
// DEVIATION FROM SPEC §组件5 pseudocode (it also listed auditProjectionKind, component 3): component 3
// has NO applicability gate (it is the b3-gate CLONE auditor where every row is backfilled), so on
// LIVE prod it would FALSE-positive every un-anchored (pre-event-sourced / §9.3 data-fix) row and
// duplicate FIELD_DRIFT. The symmetric audit subsumes it and gates un-anchored rows (M3), so the sweep
// runs the symmetric leg alone.
//
// SAFETY INVARIANTS:
//   - REPORT-ONLY: it NEVER writes an entity table (knowledge/goal/…). Its ONLY write is a fold-inert
//     forensic breadcrumb (subject_kind 'projection_oracle' — queried by NO gather, so structurally
//     fold-inert, not "the reducer happens to ignore it"), one open record per (kind,id) so it cannot
//     accumulate unboundedly or re-scan itself.
//   - SINGLE SNAPSHOT: the whole sweep runs in ONE REPEATABLE READ tx (M4/B-M5) so the row read + the
//     event read see one snapshot — a concurrent write between them cannot fabricate drift.
//   - TRACKED-FLAG ON-check (B-m8): audits an entity iff its SoT-writer FLAG is ON. It reads the flag
//     env via the registry (projectionIsWriter) — which, under the stop-the-world flip model (runbook
//     §7), is injected consistently across all processes from the git-tracked docker-compose.mac.yml,
//     so the worker's env read IS the single-source git-tracked flag (no mixed-state window; the spec
//     REJECTs a heavyweight cross-process fingerprint table as over-engineering for n=1).
//   - queue 'llm' (B-M4): the sweep WRITES evidence, so it joins the backfill family's DLQ/retry
//     bucket like its siblings ('fast' would skip the DLQ → a dropped run = a silent week-long blind
//     spot in the evidence trail).
//   - NEVER auto-repairs (red line): a projection drift auto-fix = letting the fold win = a silent
//     local SoT flip. Report only; the owner investigates.

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

// The fold-inert forensic action + subject_kind. subject_kind 'projection_oracle' is queried by NO
// gather (they only scan the 7 projection kinds + 'event'), so the breadcrumb is STRUCTURALLY invisible
// to every fold/parity/gather (not merely ignored by the reducer). NOT in RESERVED_EXPERIMENTAL_ACTIONS
// (verified: matches no proposalWhere / fold reducer / parity / kc_dedup / gather predicate).
const ORACLE_FORENSIC_ACTION = 'experimental:projection_oracle_flagged';
const ORACLE_FORENSIC_SUBJECT_KIND = 'projection_oracle';

export interface ProjectionOracleReport {
  /** kinds whose SoT flag is ON (audited). */
  auditedKinds: ProjectionKind[];
  /** kinds whose SoT flag is OFF (skipped — the imperative path is still the writer). */
  skippedKinds: ProjectionKind[];
  /** total non-CLEAN anomalies across audited kinds. */
  anomalies: number;
  ghost: number;
  missing: number;
  fieldDrift: number;
  /** fold-inert forensic breadcrumbs written this run (one per newly-flagged id). */
  forensicWritten: number;
}

export interface RunProjectionOracleSweepOpts {
  now?: Date;
  allowlist?: ProjectionAllowlist;
  /**
   * TEST-ONLY seam: awaited (with the sweep's REPEATABLE READ tx) AFTER the census completes and
   * BEFORE the forensic writes, so the isolation test can commit a concurrent out-of-tx write and
   * assert the sweep's snapshot does not see it. Mirrors merge_attribution_sweep's onBeforeRepairPhase.
   * Never set in prod.
   */
  onBeforeForensic?: (tx: Tx) => Promise<void>;
}

/** Is `kind`'s SoT-writer flag ON? Reads the flag env via the registry (bare global for
 * knowledge/edge, per-entity env otherwise) — the git-tracked flag under stop-the-world. */
function isTrackedWriter(kind: ProjectionKind): boolean {
  return projectionIsWriter(PROJECTION_ENTITIES[kind].flagEntity);
}

// Log a non-CLEAN anomaly WITHOUT leaking user content: only the diverged FIELD NAMES + count (each
// diff line is "<col>: <live> → <folded>" or a sentinel; take the prefix before the first ':').
function logAnomaly(rec: SymmetricRecord): void {
  console.warn('[projection-parity] oracle anomaly', {
    subject_kind: rec.kind,
    id: rec.id,
    verdict: rec.verdict,
    diff_fields: rec.diffs.map((line) => line.split(':', 1)[0] ?? line),
    diff_count: rec.diffs.length,
  });
}

// Write ONE fold-inert forensic breadcrumb per (kind,id), skipping ids that already have an OPEN
// record (bounds accumulation + prevents a self-scan feedback loop). Returns true iff it wrote.
async function writeForensicOnce(db: Db | Tx, rec: SymmetricRecord, now: Date): Promise<boolean> {
  const forensicSubjectId = `${rec.kind}:${rec.id}`;
  // subject_kind included (review O15): semantically precise AND lets the planner use the composite
  // event_subject_idx (subject_kind, subject_id, ...) for a direct lookup instead of scanning the
  // action index as the event table grows.
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
  if (existing.length > 0) return false; // already an open record for this id — do NOT re-write per run
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
    // ADR-0021 opt-OUT of memory ingestion: an internal forensic breadcrumb, NOT user activity —
    // without the stamp the outbox poller (WHERE ingest_at IS NULL) would feed it to Mem0.
    ingest_at: now,
  });
  return true;
}

/**
 * Run the continuous projection-drift oracle sweep. Audits every ON projection kind (symmetric,
 * anchor-gated) inside ONE REPEATABLE READ tx; logs each anomaly + writes a one-per-id fold-inert
 * forensic breadcrumb. NEVER writes an entity table, NEVER auto-repairs. Report-only.
 *
 * Throws only on a genuine DB failure (nothing written yet → pg-boss DLQ retry). Drift detection
 * itself never throws.
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

      // TEST-ONLY seam (see RunProjectionOracleSweepOpts.onBeforeForensic): the census above already
      // captured the snapshot, so a concurrent commit here must NOT change the anomalies.
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

/**
 * pg-boss handler builder. Runs the sweep + logs the outcome. A throw here is a genuine DB failure
 * (census read failed, nothing written) and propagates to pg-boss for DLQ retry.
 */
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

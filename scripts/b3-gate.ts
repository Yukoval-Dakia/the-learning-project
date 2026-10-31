// Prod-clone SoT-flip gate orchestrator.
//
// Runs the cutover gate for one projection FK-cluster at a time and prints GO / NO-GO:
//   1. snapshot the live id sets per kind;
//   2. scoped, idempotent genesis backfill for the gated kinds;
//   3. audit fold(events) against the current imperative row;
//   4. rebuild the cluster in one transaction;
//   5. compare live id sets both ways (deleted rows and stale-anchor resurrections).
//
// GO iff audit is clean, rebuild succeeds, and the row set survives.
//
// The audit must run before the rebuild: after a write-through rebuild it would compare the fold
// against itself. Running first exposes reducer drift against the imperative row.
//
// SAFETY: this mutates the target database (steps 2 and 4 write). Run it only against a
// PROD-CLONE; the CLI refuses without B3_GATE_CONFIRM_CLONE=1. The exported runB3Gate() stays
// unguarded so the DB test can drive it against the testcontainer.

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { type Db, db } from '@/db/client';
import { auditProjectionKind } from '@/server/projections/audit-kind';
import {
  PROJECTION_ENTITIES,
  PROJECTION_FK_CLUSTERS,
  type ProjectionKind,
} from '@/server/projections/entity-registry';
import {
  backfillArtifactGenesis,
  backfillGoalGenesis,
  backfillItemCalibrationGenesis,
  backfillKnowledgeEdgeGenesis,
  backfillKnowledgeGenesis,
  backfillLearningItemGenesis,
  backfillMistakeVariantGenesis,
  backfillQuestionBlockGenesis,
} from './backfill-genesis-events';
import { type ProjectionAllowlist, loadAllowlist } from './ops-projection';
import { type RebuildCounts, rebuildProjectionForKinds } from './rebuild-projection';

type KindBackfillCounts = { seeded: number; skipped: number };

// Backfill only the kinds this cluster gates. A single all-kinds pass would scan every table per
// cluster and write genesis events for kinds outside the cluster. All entries share the
// (db, now) → {seeded, skipped} shape.
const KIND_BACKFILL: Record<ProjectionKind, (db: Db, now: Date) => Promise<KindBackfillCounts>> = {
  knowledge: backfillKnowledgeGenesis,
  knowledge_edge: backfillKnowledgeEdgeGenesis,
  goal: backfillGoalGenesis,
  mistake_variant: backfillMistakeVariantGenesis,
  learning_item: backfillLearningItemGenesis,
  artifact: backfillArtifactGenesis,
  question_block: backfillQuestionBlockGenesis,
  item_calibration: backfillItemCalibrationGenesis,
};

export interface B3GateReport {
  go: boolean;
  kinds: ProjectionKind[];
  // Backfill counts for the gated kinds only (cluster-scoped).
  backfill: Partial<Record<ProjectionKind, KindBackfillCounts>>;
  // Audit runs before the rebuild, so drift is fold-vs-imperative. topologyReject carries a
  // cyclic topology or tree-redundancy invariant throw from mid-scan.
  audit: {
    clean: boolean;
    driftCount: number;
    allowedCount: number;
    topologyReject: string | null;
  };
  // The rebuild re-confirms projection invariants. ok=false with topologyReject means it rolled
  // back — hard NO-GO.
  rebuild: { ok: boolean; counts: RebuildCounts | null; topologyReject: string | null };
  // The rebuild must reproduce the exact pre-existing live id set. deleted = data loss; created =
  // a stale-anchor resurrection the live-only audit cannot see, because the rebuild id universe
  // also includes event subjects and index anchors. Either is NO-GO.
  survival: {
    ok: boolean;
    deleted: Partial<Record<ProjectionKind, string[]>>;
    created: Partial<Record<ProjectionKind, string[]>>;
  };
}

function isProjectionInvariantReject(message: string): boolean {
  return /topology reject|tree redundancy/i.test(message);
}

async function liveIdsByKind(
  db: Db,
  kinds: readonly ProjectionKind[],
): Promise<Record<string, Set<string>>> {
  const out: Record<string, Set<string>> = {};
  for (const kind of kinds) {
    out[kind] = await PROJECTION_ENTITIES[kind].liveIds(db);
  }
  return out;
}

/**
 * Run the SoT-flip gate against a clone database for one FK-cluster. Reads, writes (backfill +
 * rebuild), then verifies; returns the structured GO/NO-GO report. Exported without the safety
 * guard so tests can drive it; the CLI enforces B3_GATE_CONFIRM_CLONE.
 *
 * @param db        clone handle (must support .transaction — the rebuild needs one transaction).
 * @param kinds     projection kinds to gate (one PROJECTION_FK_CLUSTERS entry).
 * @param allowlist known-acceptable drift, same contract as ops:projection.
 * @param now       genesis timestamp; injected for deterministic tests.
 */
export async function runB3Gate(
  db: Db,
  kinds: readonly ProjectionKind[],
  allowlist: ProjectionAllowlist = {},
  now: Date = new Date(),
): Promise<B3GateReport> {
  // 1. Snapshot before anything mutates.
  const before = await liveIdsByKind(db, kinds);

  // 2. Cluster-scoped genesis backfill; the CLI's cluster loop then touches each kind once.
  const backfill: B3GateReport['backfill'] = {};
  for (const kind of kinds) {
    backfill[kind] = await KIND_BACKFILL[kind](db, now);
  }

  // 3. Audit before the rebuild. A topology/tree-redundancy throw is an invariant NO-GO; anything
  // else propagates. Counts live outside the try so a later kind's throw keeps earlier drift.
  let audit: B3GateReport['audit'];
  let driftCount = 0;
  let allowedCount = 0;
  try {
    for (const kind of kinds) {
      const r = await auditProjectionKind(db, kind, allowlist);
      driftCount += r.drift.length;
      allowedCount += r.allowed.length;
    }
    audit = { clean: driftCount === 0, driftCount, allowedCount, topologyReject: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isProjectionInvariantReject(msg)) throw err;
    audit = { clean: false, driftCount, allowedCount, topologyReject: msg };
  }

  // 4. Rebuild in one transaction. A topology/tree-redundancy reject rolls back and is NO-GO;
  // anything else propagates.
  let rebuild: B3GateReport['rebuild'];
  try {
    const counts = await db.transaction((tx) => rebuildProjectionForKinds(tx, kinds));
    rebuild = { ok: true, counts, topologyReject: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isProjectionInvariantReject(msg)) throw err;
    rebuild = { ok: false, counts: null, topologyReject: msg };
  }

  // 5. Survival: did the rebuild drop a pre-existing row or resurrect an event-only/anchored one?
  const after = await liveIdsByKind(db, kinds);
  const deleted: Partial<Record<ProjectionKind, string[]>> = {};
  const created: Partial<Record<ProjectionKind, string[]>> = {};
  let survivalOk = true;
  for (const kind of kinds) {
    const b = before[kind] ?? new Set<string>();
    const a = after[kind] ?? new Set<string>();
    const del = [...b].filter((id) => !a.has(id));
    const cre = [...a].filter((id) => !b.has(id));
    if (del.length > 0) {
      deleted[kind] = del;
      survivalOk = false;
    }
    if (cre.length > 0) {
      created[kind] = cre;
      survivalOk = false;
    }
  }
  const survival = { ok: survivalOk, deleted, created };

  const go = audit.clean && rebuild.ok && survival.ok;
  return { go, kinds: [...kinds], backfill, audit, rebuild, survival };
}

function printReport(report: B3GateReport): void {
  console.log(
    `\n=== B3 SoT-flip gate [${report.kinds.join(', ')}]: ${report.go ? 'GO ✅' : 'NO-GO ❌'} ===\n`,
  );
  // Backfill mutates (genesis events + index rows), so the human-readable path must show it too.
  const bfEntries = Object.entries(report.backfill)
    .map(([k, c]) => `${k}: seeded ${c.seeded}, skipped ${c.skipped}`)
    .join('; ');
  console.log(`backfill — ${bfEntries || '(none)'}`);
  // Audit output first: it is the fold-vs-imperative check, not the post-rebuild result.
  if (report.audit.topologyReject) {
    console.log(`audit    — NO-GO: projection invariant reject — ${report.audit.topologyReject}`);
  } else {
    const allowed =
      report.audit.allowedCount > 0 ? ` (${report.audit.allowedCount} allowlisted)` : '';
    const verdict = report.audit.clean
      ? 'CLEAN'
      : `DRIFT: ${report.audit.driftCount} drifted id(s) (fold != imperative row)`;
    console.log(`audit    — ${verdict}${allowed}`);
  }
  if (report.rebuild.ok) {
    const summary = report.rebuild.counts
      ? Object.entries(report.rebuild.counts)
          .map(([k, n]) => `${k}: ${n}`)
          .join(', ')
      : '';
    console.log(`rebuild  — OK: re-folded (${summary})`);
  } else {
    console.log(`rebuild  — NO-GO: projection invariant reject — ${report.rebuild.topologyReject}`);
  }
  if (report.survival.ok) {
    console.log(
      'survival — OK: rebuild reproduced the exact live id set per kind (no deletions, no resurrections)',
    );
  } else {
    for (const [kind, ids] of Object.entries(report.survival.deleted)) {
      console.log(`survival — NO-GO: rebuild DELETED ${kind}: ${ids.join(', ')}`);
    }
    for (const [kind, ids] of Object.entries(report.survival.created)) {
      console.log(`survival — NO-GO: rebuild RESURRECTED ${kind} (no live row): ${ids.join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  if (process.env.B3_GATE_CONFIRM_CLONE !== '1') {
    console.error(
      '[b3-gate] REFUSING TO RUN.\n' +
        'This MUTATES the target database: it writes a genesis event + materialized_id_index entry\n' +
        'for every un-anchored row (backfill) and re-folds every projection row in place (rebuild).\n' +
        'Run it ONLY against a PROD-CLONE, NEVER live prod.\n' +
        'Set B3_GATE_CONFIRM_CLONE=1 to confirm you are on a clone and proceed.',
    );
    process.exit(2);
  }
  const asJson = process.argv.includes('--json');
  const allowlist = loadAllowlist();

  const reports: B3GateReport[] = [];
  for (const cluster of PROJECTION_FK_CLUSTERS) {
    reports.push(await runB3Gate(db, cluster, allowlist));
  }
  const allGo = reports.every((r) => r.go);

  if (asJson) {
    console.log(JSON.stringify({ go: allGo, clusters: reports }, null, 2));
  } else {
    for (const r of reports) printReport(r);
    console.log(
      allGo
        ? '\nGO: every cluster backfilled, audited clean, and rebuilt to the exact same row set. To\n' +
            "flip a kind: apply the SAME genesis backfill to prod, set that kind's SoT flag on all\n" +
            'three processes + restart (stop-the-world). Rollback = unset the flag + restart.'
        : '\nNO-GO: resolve the failures above on the clone (and fix the live source), then re-run. Do NOT flip.',
    );
  }

  process.exit(allGo ? 0 : 1);
}

// CLI-gate: only run as the entry point so the DB test can import runB3Gate without side effects.
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('b3-gate.ts')) {
  main().catch((err) => {
    console.error('[b3-gate] failed:', err);
    process.exit(1);
  });
}

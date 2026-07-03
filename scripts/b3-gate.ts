// YUK-471 W1 B3 / YUK-548 (worklist #5) — the prod-clone SoT-flip GATE orchestrator.
//
// WHAT. One command that runs the documented B3 cutover gate against a (clone) database for a set of
// projection KINDS and prints a GO / NO-GO verdict for flipping that entity's SoT-writer flag. It
// chains the landed primitives + the structural safety checks the flip requires:
//
//   1. snapshot the live id sets per kind (the "before").
//   2. SCOPED genesis backfill (idempotent, ALL kinds) — anchor only TRULY event-less rows.
//   3. AUDIT (the real teeth) — fold(events) vs the CURRENT imperative row, BEFORE the rebuild
//      overwrites anything, PER requested kind. Value drift, present→fold-null, and a cyclic
//      prerequisite (fold THROWS) all surface here.
//   4. full rebuild of the requested kinds IN ONE TX (FK-cluster) — re-fold every id through the
//      write-through shells. A topology reject rolls the cluster back.
//   5. rowset parity per kind — diff the live id sets BOTH ways: a row the rebuild DELETED (data
//      loss) OR MATERIALIZED with no live counterpart (a stale-anchor resurrection the live-only
//      audit never sees) is a divergence the flip would introduce → hard NO-GO.
//
//   GO  iff  audit.clean && rebuild.ok && survival.ok.
//
// YUK-548: generalized from a hard-coded knowledge/knowledge_edge run to `runB3Gate(db, kinds, …)`.
// Callers pass an FK-CLUSTER (PROJECTION_FK_CLUSTERS): knowledge + knowledge_edge together (FK), each
// other kind alone. The CLI iterates every cluster. The knowledge/knowledge_edge GO/NO-GO VERDICTS
// are behavior-preserved (the report SHAPE changed to per-kind maps — m10).
//
// SAFETY — THIS SCRIPT MUTATES THE TARGET DATABASE (steps 2 + 4 WRITE). Run it ONLY against a
// PROD-CLONE, NEVER live prod. The CLI refuses unless B3_GATE_CONFIRM_CLONE=1. The exported
// runB3Gate() is unguarded so the DB test can drive it against the testcontainer.
//
// WHY THE AUDIT RUNS BEFORE THE REBUILD (real value teeth). The rebuild WRITES the fold through, so a
// post-rebuild audit would compare the fold against itself — tautologically clean. Run BEFORE, the
// audit compares fold(events) against the IMPERATIVE row, so a mutation-reducer value bug surfaces as
// DRIFT. This is only real teeth because the backfill is SCOPED (an already-event-sourced row is NOT
// genesis-anchored, so its fold re-derives through its reducers rather than collapsing to a
// current-state snapshot — an unscoped backfill would mask exactly this divergence).
//
// NOT in the `pnpm test` chain — like audit:projection it needs a populated DB. CI coverage is the DB
// test (b3-gate.db.test.ts): the GO path + every NO-GO leg (topology, drift, deletion, resurrection)
// for knowledge/edge AND each W2/W3 entity.
//
// CLI:
//   B3_GATE_CONFIRM_CLONE=1 pnpm b3:gate          # human-readable GO / NO-GO per cluster; exit 0/1
//   B3_GATE_CONFIRM_CLONE=1 pnpm b3:gate --json    # JSON report

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { type Db, db } from '@/db/client';
import { auditProjectionKind } from '@/server/projections/audit-kind';
import {
  PROJECTION_ENTITIES,
  PROJECTION_FK_CLUSTERS,
  type ProjectionKind,
} from '@/server/projections/entity-registry';
import { type ProjectionAllowlist, loadAllowlist } from './audit-projection';
import { type BackfillCounts, backfillGenesisEvents } from './backfill-genesis-events';
import { type RebuildCounts, rebuildProjectionForKinds } from './rebuild-projection';

export interface B3GateReport {
  go: boolean;
  kinds: ProjectionKind[];
  backfill: BackfillCounts;
  // audit runs BEFORE the rebuild — fold(events) vs the CURRENT imperative row (real value-drift
  // teeth). driftCount = non-allowlisted drift over the requested kinds; topologyReject is set if
  // folding a cyclic prerequisite THROWS mid-scan.
  audit: {
    clean: boolean;
    driftCount: number;
    allowedCount: number;
    topologyReject: string | null;
  };
  // rebuild materializes the post-flip state + independently re-confirms topology. ok=false with a
  // topologyReject means it aborted (rolled back) on an ADR-0034 cycle/direction reject — hard NO-GO.
  rebuild: { ok: boolean; counts: RebuildCounts | null; topologyReject: string | null };
  // rowset parity (named `survival`) — the rebuild must reproduce the EXACT pre-existing live id set
  // per kind. deleted = rows the rebuild dropped (data LOSS on flip). created = rows the rebuild
  // MATERIALIZED that had no live counterpart (a stale-anchor resurrection the live-only audit never
  // sees, since the rebuild id universe is BROADER: event subjects + index anchors). Either → NO-GO.
  survival: {
    ok: boolean;
    deleted: Partial<Record<ProjectionKind, string[]>>;
    created: Partial<Record<ProjectionKind, string[]>>;
  };
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
 * Run the B3 SoT-flip gate against `db` (a CLONE) for the given `kinds` (an FK-cluster). READS then
 * WRITES (backfill + rebuild), then verifies. Returns the structured GO/NO-GO report. Exported (no
 * safety gate) so the DB test can drive it; the CLI `main()` enforces the B3_GATE_CONFIRM_CLONE guard.
 *
 * @param db        the clone DB handle (must support .transaction — the rebuild needs one tx).
 * @param kinds     the projection kinds to gate (a PROJECTION_FK_CLUSTERS entry).
 * @param allowlist known-acceptable drift (mirrors audit:projection's allowlist).
 * @param now       genesis-backfill timestamp (defaults to new Date()); injected for deterministic tests.
 */
export async function runB3Gate(
  db: Db,
  kinds: readonly ProjectionKind[],
  allowlist: ProjectionAllowlist = {},
  now: Date = new Date(),
): Promise<B3GateReport> {
  // 1. snapshot the live id sets per kind BEFORE the gate mutates anything.
  const before = await liveIdsByKind(db, kinds);

  // 2. genesis backfill (idempotent, ALL kinds). Idempotent, so re-running per cluster is safe; the
  // backfill contract is "apply the SAME backfill to prod".
  const backfill = await backfillGenesisEvents(db, now);

  // 3. AUDIT — the real teeth. Compare fold(events) against the CURRENT imperative row PER kind,
  // BEFORE the rebuild. A cyclic prerequisite makes the edge fold THROW — caught here as a topology
  // NO-GO (the rebuild re-confirms at step 4). A NON-topology error is a real failure and propagates.
  let audit: B3GateReport['audit'];
  try {
    let driftCount = 0;
    let allowedCount = 0;
    for (const kind of kinds) {
      const r = await auditProjectionKind(db, kind, allowlist);
      driftCount += r.drift.length;
      allowedCount += r.allowed.length;
    }
    audit = { clean: driftCount === 0, driftCount, allowedCount, topologyReject: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/topology reject/i.test(msg)) throw err;
    audit = { clean: false, driftCount: 0, allowedCount: 0, topologyReject: msg };
  }

  // 4. rebuild IN ONE TX (FK-cluster) — materialize the post-flip state + independently re-confirm
  // topology. A topology reject rolls the cluster back and is reported as NO-GO; any OTHER error
  // propagates.
  let rebuild: B3GateReport['rebuild'];
  try {
    const counts = await db.transaction((tx) => rebuildProjectionForKinds(tx, kinds));
    rebuild = { ok: true, counts, topologyReject: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/topology reject/i.test(msg)) throw err;
    rebuild = { ok: false, counts: null, topologyReject: msg };
  }

  // 5. survival — per kind, did the rebuild drop a pre-existing row (data loss) or resurrect an
  // event-only/anchored row with no live counterpart?
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
  // audit FIRST (it runs before the rebuild — the real fold-vs-imperative teeth).
  if (report.audit.topologyReject) {
    console.log(
      `audit    — NO-GO: ADR-0034 topology reject during fold — ${report.audit.topologyReject}`,
    );
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
    console.log(`rebuild  — NO-GO: ADR-0034 topology reject — ${report.rebuild.topologyReject}`);
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

// CLI-gate: only run + exit as the CLI entry point so the DB test can import runB3Gate without
// the top-level run firing.
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('b3-gate.ts')) {
  main().catch((err) => {
    console.error('[b3-gate] failed:', err);
    process.exit(1);
  });
}

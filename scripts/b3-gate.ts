// YUK-471 W1 B3 — the prod-clone SoT-flip GATE orchestrator.
//
// WHAT. One command that runs the documented B3 cutover gate against a (clone) database and
// prints a GO / NO-GO verdict for flipping PROJECTION_IS_WRITER=1 (the projection becoming the
// sole writer of knowledge / knowledge_edge). It chains the three already-landed primitives and
// adds the two structural safety checks the flip requires:
//
//   1. snapshot the live `knowledge` / `knowledge_edge` id sets (the "before").
//   2. genesis backfill (idempotent) — anchor every un-anchored row so the fold can reproduce it.
//   3. full projection rebuild IN ONE TX — re-fold every node + edge through the IO shells in
//      place. A topology reject (ADR-0034 cycle/direction) rolls the whole rebuild back.
//   4. survival check — diff the live id sets: did the rebuild DELETE any pre-existing row? With
//      the keystone non-delete guard (PR-B) + the backfill anchors this must be empty; a deletion
//      means a row would be LOST on the flip → hard NO-GO.
//   5. audit:projection — fold(events) == row for every live row (zero non-allowlisted drift).
//
//   GO  iff  rebuild.ok && survival.ok && audit.clean.
//
// SAFETY — THIS SCRIPT MUTATES THE TARGET DATABASE (steps 2 + 3 WRITE: genesis events +
// materialized_id_index entries, and re-fold every row in place). Run it ONLY against a
// PROD-CLONE, NEVER live prod. The CLI refuses unless B3_GATE_CONFIRM_CLONE=1 is set. The
// exported runB3Gate() is unguarded so the DB test can drive it against the testcontainer.
//
// WHAT THE GATE DOES AND DOES NOT PROVE. The genesis backfill seeds, for every row lacking a
// genesis event, a system `experimental:genesis` snapshot of that row's CURRENT state, stamped
// at backfill time — i.e. LATER than any accept-path event the row already has. Because the fold
// applies events in (created_at, id) order, that genesis snapshot is applied LAST, so after the
// backfill fold(events) == row holds by construction for value columns. The gate's load-bearing
// teeth are therefore (a) the topology reject (a create event is folded BEFORE the genesis and
// re-runs the ADR-0034 gate the imperative accept path never ran — this catches a cyclic
// prerequisite pair that exists imperatively) and (b) the survival check (no row dropped). The
// per-accept fold-CORRECTNESS of event-sourced rows is verified separately and continuously by
// the A2b parity assert on the live OFF path (src/server/projections/parity.ts); this gate is the
// offline pre-flip dry-run of the prod prep, not a substitute for it.
//
// PROD FLIP. A clean GO on the clone means: apply the SAME genesis backfill to prod (idempotent,
// outbox-opt-out), THEN set PROJECTION_IS_WRITER=1 on all three processes (API / worker / Vite)
// and restart. Rollback = unset the flag + restart (the A2b OFF path resumes). The clone run is
// the dry-run; it does not itself touch prod.
//
// NOT in the `pnpm test` chain — like audit:projection it needs a populated DB and is meaningless
// against the empty CI testcontainer. CI coverage is the DB test (b3-gate.db.test.ts), which
// drives runB3Gate against a seeded testcontainer for both the GO and the NO-GO (topology) paths.
//
// CLI:
//   B3_GATE_CONFIRM_CLONE=1 pnpm b3:gate          # human-readable GO / NO-GO; exit 0 (GO) / 1 (NO-GO)
//   B3_GATE_CONFIRM_CLONE=1 pnpm b3:gate --json    # JSON report

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { type Db, db } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import { type ProjectionAllowlist, auditProjection, loadAllowlist } from './audit-projection';
import { type BackfillCounts, backfillGenesisEvents } from './backfill-genesis-events';
import { type RebuildCounts, rebuildProjection } from './rebuild-projection';

export interface B3GateReport {
  go: boolean;
  backfill: BackfillCounts;
  // rebuild.ok=false with a topologyReject means the rebuild aborted (rolled back) on an ADR-0034
  // cycle/direction reject — a hard NO-GO. counts is the re-folded id counts on success.
  rebuild: { ok: boolean; counts: RebuildCounts | null; topologyReject: string | null };
  // audit runs only when the rebuild SUCCEEDED — a rebuild that topology-rejected leaves the
  // cyclic edge live, so the audit's fold would re-throw on the same reject; the gate is already
  // NO-GO, so the audit is skipped (ran=false) rather than crashing the run.
  audit: { ran: boolean; clean: boolean; driftCount: number; allowedCount: number };
  // survival: ids present before the gate but gone after the rebuild (should be empty).
  survival: { ok: boolean; deletedKnowledge: string[]; deletedEdges: string[] };
}

async function liveNodeIds(db: Db): Promise<Set<string>> {
  const rows = await db.select({ id: knowledge.id }).from(knowledge);
  return new Set(rows.map((r) => r.id));
}

async function liveEdgeIds(db: Db): Promise<Set<string>> {
  const rows = await db.select({ id: knowledge_edge.id }).from(knowledge_edge);
  return new Set(rows.map((r) => r.id));
}

/**
 * Run the B3 SoT-flip gate against `db` (a CLONE). READS then WRITES (backfill + rebuild), then
 * verifies. Returns the structured GO/NO-GO report. Exported (no safety gate) so the DB test can
 * drive it; the CLI `main()` enforces the B3_GATE_CONFIRM_CLONE guard.
 *
 * @param db        the clone DB handle (must support .transaction — the rebuild needs one tx).
 * @param allowlist known-acceptable drift (mirrors audit:projection's allowlist).
 * @param now       genesis-backfill timestamp (defaults to new Date()); injected for deterministic tests.
 */
export async function runB3Gate(
  db: Db,
  allowlist: ProjectionAllowlist = {},
  now: Date = new Date(),
): Promise<B3GateReport> {
  // 1. snapshot the live id sets BEFORE the gate mutates anything.
  const beforeNodes = await liveNodeIds(db);
  const beforeEdges = await liveEdgeIds(db);

  // 2. genesis backfill (idempotent) — anchor every un-anchored row.
  const backfill = await backfillGenesisEvents(db, now);

  // 3. full rebuild IN ONE TX. A topology reject rolls the whole rebuild back and is reported as
  // NO-GO (not a crash); any OTHER error is a real failure and propagates.
  let rebuild: B3GateReport['rebuild'];
  try {
    const counts = await db.transaction((tx) => rebuildProjection(tx));
    rebuild = { ok: true, counts, topologyReject: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/topology reject/i.test(msg)) {
      rebuild = { ok: false, counts: null, topologyReject: msg };
    } else {
      throw err;
    }
  }

  // 4. survival — did the rebuild drop any pre-existing row? (The keystone non-delete guard +
  // backfill anchors should make this empty; a non-empty set is a hard NO-GO — data loss on flip.)
  const afterNodes = await liveNodeIds(db);
  const afterEdges = await liveEdgeIds(db);
  const deletedKnowledge = [...beforeNodes].filter((id) => !afterNodes.has(id));
  const deletedEdges = [...beforeEdges].filter((id) => !afterEdges.has(id));
  const survival = {
    ok: deletedKnowledge.length === 0 && deletedEdges.length === 0,
    deletedKnowledge,
    deletedEdges,
  };

  // 5. audit — fold(events) == row for every live row (zero non-allowlisted drift). Skipped when
  // the rebuild already topology-rejected: that leaves the cyclic edge live, so the audit's fold
  // would re-throw on the same reject, and the gate is already NO-GO.
  let audit: B3GateReport['audit'];
  if (rebuild.ok) {
    const auditResult = await auditProjection(db, allowlist);
    audit = {
      ran: true,
      clean: auditResult.ok,
      driftCount: auditResult.drift.length,
      allowedCount: auditResult.allowed.length,
    };
  } else {
    audit = { ran: false, clean: false, driftCount: 0, allowedCount: 0 };
  }

  const go = rebuild.ok && survival.ok && audit.clean;
  return { go, backfill, rebuild, audit, survival };
}

function printReport(report: B3GateReport): void {
  console.log(`\n=== B3 SoT-flip gate: ${report.go ? 'GO ✅' : 'NO-GO ❌'} ===\n`);
  console.log(
    `backfill — knowledge: seeded ${report.backfill.knowledge.seeded}, skipped ${report.backfill.knowledge.skipped}; ` +
      `edge: seeded ${report.backfill.knowledge_edge.seeded}, skipped ${report.backfill.knowledge_edge.skipped}`,
  );
  if (report.rebuild.ok) {
    console.log(
      `rebuild  — OK: re-folded ${report.rebuild.counts?.nodes ?? 0} node(s) + ${report.rebuild.counts?.edges ?? 0} edge(s)`,
    );
  } else {
    console.log(`rebuild  — NO-GO: ADR-0034 topology reject — ${report.rebuild.topologyReject}`);
  }
  if (report.survival.ok) {
    console.log('survival — OK: zero rows deleted by the rebuild');
  } else {
    console.log(
      `survival — NO-GO: rebuild dropped ${report.survival.deletedKnowledge.length} node(s) + ${report.survival.deletedEdges.length} edge(s)`,
    );
    if (report.survival.deletedKnowledge.length > 0) {
      console.log(`  deleted knowledge: ${report.survival.deletedKnowledge.join(', ')}`);
    }
    if (report.survival.deletedEdges.length > 0) {
      console.log(`  deleted edges: ${report.survival.deletedEdges.join(', ')}`);
    }
  }
  if (!report.audit.ran) {
    console.log('audit    — skipped (rebuild did not complete)');
  } else {
    const allowed =
      report.audit.allowedCount > 0 ? ` (${report.audit.allowedCount} allowlisted)` : '';
    const verdict = report.audit.clean
      ? 'CLEAN'
      : `DRIFT: ${report.audit.driftCount} drifted id(s)`;
    console.log(`audit    — ${verdict}${allowed}`);
  }
  console.log(
    report.go
      ? '\nGO: this clone backfilled, rebuilt, and audited clean with zero deletions. To flip prod: apply the\n' +
          'SAME genesis backfill to prod, then set PROJECTION_IS_WRITER=1 on all three processes + restart.\n' +
          'Rollback = unset the flag + restart (the A2b OFF path resumes).'
      : '\nNO-GO: resolve the failures above on the clone (and fix the live source), then re-run. Do NOT flip.',
  );
}

async function main(): Promise<void> {
  if (process.env.B3_GATE_CONFIRM_CLONE !== '1') {
    console.error(
      '[b3-gate] REFUSING TO RUN.\n' +
        'This MUTATES the target database: it writes a genesis event + materialized_id_index entry\n' +
        'for every un-anchored row (backfill) and re-folds every knowledge/knowledge_edge row in\n' +
        'place (rebuild). Run it ONLY against a PROD-CLONE, NEVER live prod.\n' +
        'Set B3_GATE_CONFIRM_CLONE=1 to confirm you are on a clone and proceed.',
    );
    process.exit(2);
  }
  const asJson = process.argv.includes('--json');
  const allowlist = loadAllowlist();
  const report = await runB3Gate(db, allowlist);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exit(report.go ? 0 : 1);
}

// CLI-gate: only run + exit as the CLI entry point so the DB test can import runB3Gate without
// the top-level run firing.
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('b3-gate.ts')) {
  main().catch((err) => {
    console.error('[b3-gate] failed:', err);
    process.exit(1);
  });
}

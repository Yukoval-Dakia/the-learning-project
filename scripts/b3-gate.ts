// YUK-471 W1 B3 — the prod-clone SoT-flip GATE orchestrator.
//
// WHAT. One command that runs the documented B3 cutover gate against a (clone) database and
// prints a GO / NO-GO verdict for flipping PROJECTION_IS_WRITER=1 (the projection becoming the
// sole writer of knowledge / knowledge_edge). It chains the three already-landed primitives and
// adds the structural safety checks the flip requires:
//
//   1. snapshot the live `knowledge` / `knowledge_edge` id sets (the "before").
//   2. SCOPED genesis backfill (idempotent) — anchor only TRULY event-less rows (seed roots /
//      pre-W1 legacy). Already-event-sourced rows are NOT anchored (see backfill-genesis-events.ts).
//   3. AUDIT (the real teeth) — fold(events) vs the CURRENT imperative row, BEFORE the rebuild
//      overwrites anything. Value drift (a mutation-reducer bug), present→fold-null, and a cyclic
//      prerequisite (fold THROWS) all surface here.
//   4. full projection rebuild IN ONE TX — re-fold every node + edge through the IO shells in
//      place (materialize the post-flip state). A topology reject rolls the whole rebuild back.
//   5. rowset parity — diff the live id sets BOTH ways: a row the rebuild DELETED (data loss) OR
//      MATERIALIZED with no live counterpart (a stale-anchor resurrection the live-only audit never
//      sees) is a divergence the flip would introduce → hard NO-GO.
//
//   GO  iff  audit.clean && rebuild.ok && survival.ok.
//
// SAFETY — THIS SCRIPT MUTATES THE TARGET DATABASE (steps 2 + 4 WRITE: genesis events +
// materialized_id_index entries, and re-fold every row in place). Run it ONLY against a
// PROD-CLONE, NEVER live prod. The CLI refuses unless B3_GATE_CONFIRM_CLONE=1 is set. The
// exported runB3Gate() is unguarded so the DB test can drive it against the testcontainer.
//
// WHY THE AUDIT RUNS BEFORE THE REBUILD (real value teeth). The rebuild WRITES the fold through,
// so a post-rebuild audit would compare the fold against itself — tautologically clean. Run BEFORE
// the rebuild, the audit compares fold(events) against the IMPERATIVE row the live accept path
// wrote, so a mutation-reducer value bug (reparent / merge / archive / split) surfaces as DRIFT.
// This is only real teeth because the backfill is SCOPED: an already-event-sourced row is NOT
// genesis-anchored, so its fold re-derives through its reducers rather than collapsing to a
// current-state snapshot (an unscoped backfill stamps a genesis snapshot LAST in the fold and
// masks exactly this divergence). Together: scoped backfill + pre-rebuild audit = the gate
// independently verifies per-accept fold correctness on the clone, complementing the live A2b
// parity assert (src/server/projections/parity.ts), which only warns (not blocks) in production.
//
// PROD FLIP. A clean GO on the clone means: apply the SAME genesis backfill to prod (idempotent,
// outbox-opt-out), THEN set PROJECTION_IS_WRITER=1 on all three processes (API / worker / Vite)
// and restart. Rollback = unset the flag + restart (the A2b OFF path resumes). The clone run is
// the dry-run; it does not itself touch prod.
//
// NOT in the `pnpm test` chain — like audit:projection it needs a populated DB and is meaningless
// against the empty CI testcontainer. CI coverage is the DB test (b3-gate.db.test.ts), which drives
// runB3Gate against a seeded testcontainer for the GO path and all three NO-GO legs: topology
// reject, audit value-drift (fold != imperative row), and survival (a row the rebuild would delete).
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
  // audit runs BEFORE the rebuild — it compares fold(events) against the CURRENT imperative row,
  // which is the real value-drift teeth (AFTER a rebuild the row IS the fold, so a post-rebuild
  // audit is tautological). driftCount = non-allowlisted drift (a value mismatch or a
  // present→fold-null); topologyReject is set if folding a cyclic prerequisite THROWS mid-scan.
  audit: {
    clean: boolean;
    driftCount: number;
    allowedCount: number;
    topologyReject: string | null;
  };
  // rebuild materializes the post-flip state + independently re-confirms topology. ok=false with a
  // topologyReject means it aborted (rolled back) on an ADR-0034 cycle/direction reject — hard NO-GO.
  rebuild: { ok: boolean; counts: RebuildCounts | null; topologyReject: string | null };
  // rowset parity (named `survival` for back-compat) — the rebuild must reproduce the EXACT
  // pre-existing live id set. deleted* = rows the rebuild dropped (data LOSS on flip). created* =
  // rows the rebuild MATERIALIZED that had no live counterpart — the rebuild's id universe is
  // BROADER than the audit's live-only scan (it also projects materialized_id_index anchors + every
  // edge subject_id in the event log), so an anchored id whose live row was dropped out-of-band
  // folds non-null and the flip would RESURRECT it (a row the audit never sees). Either direction is
  // a divergence the flip introduces → hard NO-GO.
  survival: {
    ok: boolean;
    deletedKnowledge: string[];
    deletedEdges: string[];
    createdKnowledge: string[];
    createdEdges: string[];
  };
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

  // 3. AUDIT — the real teeth. Compare fold(events) against the CURRENT imperative row BEFORE the
  // rebuild overwrites anything (a post-rebuild audit would be tautological: the row IS the fold).
  // With the scoped backfill, accept-path rows are NOT genesis-masked, so a mutation-reducer value
  // bug surfaces here as DRIFT; a present row that folds to null surfaces as a "present → fold-null"
  // drift; a cyclic prerequisite makes the fold THROW — caught here as a topology NO-GO (the rebuild
  // re-confirms it at step 4). A NON-topology error is a real failure and propagates.
  let audit: B3GateReport['audit'];
  try {
    const r = await auditProjection(db, allowlist);
    audit = {
      clean: r.ok,
      driftCount: r.drift.length,
      allowedCount: r.allowed.length,
      topologyReject: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/topology reject/i.test(msg)) throw err;
    audit = { clean: false, driftCount: 0, allowedCount: 0, topologyReject: msg };
  }

  // 4. rebuild IN ONE TX — materialize the post-flip state + independently re-confirm topology. A
  // topology reject rolls it back and is reported as NO-GO (not a crash); any OTHER error propagates.
  let rebuild: B3GateReport['rebuild'];
  try {
    const counts = await db.transaction((tx) => rebuildProjection(tx));
    rebuild = { ok: true, counts, topologyReject: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/topology reject/i.test(msg)) throw err;
    rebuild = { ok: false, counts: null, topologyReject: msg };
  }

  // 5. survival — did the rebuild drop any pre-existing row? (Backfill anchors event-less rows + the
  // keystone non-delete guard protects un-anchored fold-nulls, so this should be empty; a non-empty
  // set is a hard NO-GO — data loss. A row that folds to null also shows as a step-3 audit drift.)
  const afterNodes = await liveNodeIds(db);
  const afterEdges = await liveEdgeIds(db);
  const deletedKnowledge = [...beforeNodes].filter((id) => !afterNodes.has(id));
  const deletedEdges = [...beforeEdges].filter((id) => !afterEdges.has(id));
  // created* — the rebuild materialized a row with NO pre-existing live counterpart. The rebuild's
  // id universe is BROADER than the audit's live-only scan (it also projects materialized_id_index
  // anchors + every edge subject_id in the event log), so an anchored id whose live row was dropped
  // out-of-band folds non-null → the flip RESURRECTS it. The audit never sees this class, so the
  // rowset diff is the only leg that catches it.
  const createdKnowledge = [...afterNodes].filter((id) => !beforeNodes.has(id));
  const createdEdges = [...afterEdges].filter((id) => !beforeEdges.has(id));
  const survival = {
    ok:
      deletedKnowledge.length === 0 &&
      deletedEdges.length === 0 &&
      createdKnowledge.length === 0 &&
      createdEdges.length === 0,
    deletedKnowledge,
    deletedEdges,
    createdKnowledge,
    createdEdges,
  };

  const go = audit.clean && rebuild.ok && survival.ok;
  return { go, backfill, audit, rebuild, survival };
}

function printReport(report: B3GateReport): void {
  console.log(`\n=== B3 SoT-flip gate: ${report.go ? 'GO ✅' : 'NO-GO ❌'} ===\n`);
  console.log(
    `backfill — knowledge: seeded ${report.backfill.knowledge.seeded}, skipped ${report.backfill.knowledge.skipped}; ` +
      `edge: seeded ${report.backfill.knowledge_edge.seeded}, skipped ${report.backfill.knowledge_edge.skipped}`,
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
    console.log(
      `rebuild  — OK: re-folded ${report.rebuild.counts?.nodes ?? 0} node(s) + ${report.rebuild.counts?.edges ?? 0} edge(s)`,
    );
  } else {
    console.log(`rebuild  — NO-GO: ADR-0034 topology reject — ${report.rebuild.topologyReject}`);
  }
  if (report.survival.ok) {
    console.log(
      'survival — OK: rebuild reproduced the exact live id set (no deletions, no resurrections)',
    );
  } else {
    const deleted = report.survival.deletedKnowledge.length + report.survival.deletedEdges.length;
    const created = report.survival.createdKnowledge.length + report.survival.createdEdges.length;
    console.log(
      `survival — NO-GO: rebuild dropped ${deleted} row(s) + resurrected ${created} row(s)`,
    );
    if (report.survival.deletedKnowledge.length > 0) {
      console.log(`  deleted knowledge: ${report.survival.deletedKnowledge.join(', ')}`);
    }
    if (report.survival.deletedEdges.length > 0) {
      console.log(`  deleted edges: ${report.survival.deletedEdges.join(', ')}`);
    }
    if (report.survival.createdKnowledge.length > 0) {
      console.log(
        `  resurrected knowledge (no live row, anchor/events present): ${report.survival.createdKnowledge.join(', ')}`,
      );
    }
    if (report.survival.createdEdges.length > 0) {
      console.log(
        `  resurrected edges (no live row, events present): ${report.survival.createdEdges.join(', ')}`,
      );
    }
  }
  console.log(
    report.go
      ? '\nGO: this clone backfilled, audited clean (fold == imperative row), and rebuilt to the exact same\n' +
          'row set (no deletions, no resurrections). To flip prod: apply the\n' +
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

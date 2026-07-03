// YUK-471 W1 PR-A2a — audit:projection: the event-sourcing drift auditor.
//
// WHAT. For every live row of every projection kind, re-derive the EXPECTED structural snapshot by
// folding that id's events IN MEMORY (via the SAME shared gather helpers the IO shells use —
// gather.ts) and DEEP-DIFF it against the live row's structural columns. A live row that differs
// from fold(events) is DRIFT: the projection and its source-of-truth event log disagree. Drifted ids
// are printed and the process exits 1; a clean run exits 0.
//
// WHY a SEPARATE re-derivation, not the shell. The shell WRITES the fold through; the auditor must
// re-derive WITHOUT writing and compare. Both call the identical gather.ts read→fold, so the auditor
// reconstructs a row exactly as the SoT path does — it cannot be blind to a gather bug that also
// corrupts the live write.
//
// YUK-548 (worklist #5) — the seven per-kind loops moved to the registry-driven
// src/server/projections/audit-kind.ts (`auditProjectionKind`), so this module is now a thin loop
// over ALL_PROJECTION_KINDS plus the CLI/allowlist wiring. The per-kind logic is byte-identical.
//
// DECISION — NOT in the `pnpm test` chain (do NOT wire it in). It needs a POPULATED DB:
//   - against the empty CI testcontainer it is meaningless (zero rows → trivially clean), and
//   - against imperatively-created test rows (no genesis events) it would FALSE-POSITIVE every row.
// It is a STANDALONE tool the owner runs against a PROD-CLONE for PR-B's B3 gate. Its CI coverage is
// the DB test (audit-projection.db.test.ts), which seeds a coherent fixture and asserts CLEAN, then
// mutates a live row out-of-band and asserts DRIFT — testing the auditProjection FUNCTION.
//
// ALLOWLIST. scripts/audit-projection-allowlist.json (mirror audit-schema-allowlist.json):
// id → { reason, resolves_when{kind,ref,expected_by} }. An allowlisted drifted id is reported as
// ALLOWED (not a failure). Empty by default.
//
// CLI:
//   pnpm audit:projection          # drift report; exit 1 if any non-allowlisted drift
//   pnpm audit:projection --json   # JSON output

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Db, type Tx, db } from '@/db/client';
import {
  type AllowlistEntry,
  type DriftRecord,
  type KindAuditResult,
  type ProjectionAllowlist,
  auditProjectionKind,
} from '@/server/projections/audit-kind';
import { ALL_PROJECTION_KINDS, type ProjectionKind } from '@/server/projections/entity-registry';

type DbLike = Db | Tx;

// Re-export the shapes moved to audit-kind.ts so existing importers (b3-gate.ts, the DB tests) keep
// their `from './audit-projection'` imports working.
export type { AllowlistEntry, DriftRecord, ProjectionAllowlist };

const ALLOWLIST_PATH = resolve(
  fileURLToPath(new URL('./audit-projection-allowlist.json', import.meta.url)),
);

export function loadAllowlist(path: string = ALLOWLIST_PATH): ProjectionAllowlist {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const out: ProjectionAllowlist = {};
  for (const [id, val] of Object.entries(raw)) {
    if (id.startsWith('_comment')) continue; // skip doc keys
    out[id] = val as AllowlistEntry;
  }
  return out;
}

export interface AuditResult {
  ok: boolean; // true iff zero NON-allowlisted drift
  checkedNodes: number;
  checkedEdges: number;
  checkedGoals: number;
  checkedMistakeVariants: number;
  checkedLearningItems: number;
  checkedArtifacts: number;
  checkedQuestionBlocks: number;
  drift: DriftRecord[]; // non-allowlisted drift (the failures)
  allowed: DriftRecord[]; // drifted ids covered by the allowlist (reported, not failures)
}

/**
 * Re-derive fold(events) for every live row of every projection kind and deep-diff against the live
 * row. Returns the AuditResult (non-allowlisted drift makes ok=false). READ-ONLY — writes nothing.
 * Loops ALL_PROJECTION_KINDS in order via the registry-driven per-kind auditor (component 3), so
 * adding a kind to the registry automatically extends the audit — no new branch here.
 */
export async function auditProjection(
  db: DbLike,
  allowlist: ProjectionAllowlist = {},
): Promise<AuditResult> {
  const drift: DriftRecord[] = [];
  const allowed: DriftRecord[] = [];
  const checked: Partial<Record<ProjectionKind, KindAuditResult>> = {};
  for (const kind of ALL_PROJECTION_KINDS) {
    const r = await auditProjectionKind(db, kind, allowlist);
    checked[kind] = r;
    drift.push(...r.drift);
    allowed.push(...r.allowed);
  }
  return {
    ok: drift.length === 0,
    checkedNodes: checked.knowledge?.checked ?? 0,
    checkedEdges: checked.knowledge_edge?.checked ?? 0,
    checkedGoals: checked.goal?.checked ?? 0,
    checkedMistakeVariants: checked.mistake_variant?.checked ?? 0,
    checkedLearningItems: checked.learning_item?.checked ?? 0,
    checkedArtifacts: checked.artifact?.checked ?? 0,
    checkedQuestionBlocks: checked.question_block?.checked ?? 0,
    drift,
    allowed,
  };
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const allowlist = loadAllowlist();
  const result = await auditProjection(db, allowlist);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `audit:projection — checked ${result.checkedNodes} node(s) + ${result.checkedEdges} edge(s) + ${result.checkedGoals} goal(s) + ${result.checkedMistakeVariants} mistake_variant(s) + ${result.checkedLearningItems} learning_item(s) + ${result.checkedArtifacts} artifact(s) + ${result.checkedQuestionBlocks} question_block(s).`,
    );
    if (result.allowed.length > 0) {
      console.log(`\nALLOWED drift (covered by allowlist):  ${result.allowed.length}`);
      for (const r of result.allowed) {
        console.log(`  - ${r.subject_kind} ${r.id}: ${r.diffs.join('; ')}`);
      }
    }
    if (result.drift.length === 0) {
      console.log('\nDRIFT (live row != fold(events)):  (none) — projection in sync.');
    } else {
      console.log(`\nDRIFT (live row != fold(events)):  ${result.drift.length}`);
      for (const r of result.drift) {
        console.log(`  - ${r.subject_kind} ${r.id}:`);
        for (const d of r.diffs) console.log(`      ${d}`);
      }
      console.log(
        '\nA drifted row means the live projection disagrees with its source-of-truth event ' +
          'log. Either an out-of-band write bypassed the projection (rebuild it: ' +
          'pnpm rebuild:projection) or a gather/fold bug is dropping a mutation. If the drift ' +
          'is intentional, add the id to scripts/audit-projection-allowlist.json with a ' +
          'reason + resolves_when.',
      );
    }
  }

  if (!result.ok) process.exit(1);
}

// CLI-gate: only run + exit as the CLI entry point so the DB test can import auditProjection
// without the top-level scan firing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[audit-projection] failed:', err);
      process.exit(1);
    });
}

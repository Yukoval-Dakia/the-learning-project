// YUK-471 W1 PR-A2a — audit:projection: the event-sourcing drift auditor.
//
// WHAT. For every live `knowledge` row (then every `knowledge_edge` row), re-derive the
// EXPECTED structural snapshot by folding that id's events IN MEMORY (via the SAME shared
// gather helpers the IO shells use — gather.ts), and DEEP-DIFF it against the live row's
// structural columns. A live row that differs from fold(events) is DRIFT: the projection and
// its source-of-truth event log disagree. Drifted ids are printed and the process exits 1;
// a clean run exits 0.
//
// WHY a SEPARATE re-derivation, not the shell. The shell WRITES the fold through; the auditor
// must re-derive WITHOUT writing and compare. Both call the identical gather.ts read→fold, so
// the auditor reconstructs a row exactly as the SoT path does — it cannot be blind to a gather
// bug that also corrupts the live write.
//
// DECISION — NOT in the `pnpm test` chain (do NOT wire it in). It needs a POPULATED DB:
//   - against the empty CI testcontainer it is meaningless (zero rows → trivially clean), and
//   - against imperatively-created test rows (no genesis events / no double-write yet) it
//     would FALSE-POSITIVE every row as drift (fold(no events)=null ≠ the live row).
// It is a STANDALONE tool the owner runs against a PROD-CLONE for PR-B's B3 gate (genesis-
// backfill + rebuild the clone, then audit:projection must report CLEAN). Its CI coverage is
// the DB test (audit-projection.db.test.ts), which seeds a coherent genesis+index fixture and
// asserts CLEAN, then mutates a live row out-of-band and asserts DRIFT — testing the
// auditProjection FUNCTION, not the process exit.
//
// ALLOWLIST. scripts/audit-projection-allowlist.json (mirror audit-schema-allowlist.json):
// id → { reason, resolves_when{kind,ref,expected_by} }. An allowlisted drifted id is reported
// as ALLOWED (not a failure). Empty by default — pre-flip a freshly backfilled+rebuilt clone
// has zero drift.
//
// CLI:
//   pnpm audit:projection          # drift report; exit 1 if any non-allowlisted drift
//   pnpm audit:projection --json   # JSON output

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { KnowledgeEdgeRowSnapshotT, KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import { type Db, type Tx, db } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import {
  gatherAndFoldKnowledgeEdge,
  gatherAndFoldKnowledgeNode,
} from '@/server/projections/gather';

type DbLike = Db | Tx;
type KnowledgeRow = typeof knowledge.$inferSelect;
type EdgeRow = typeof knowledge_edge.$inferSelect;

// ── Allowlist shape (mirror audit-schema-allowlist.json) ──────────────────────────────
export interface AllowlistEntry {
  reason: string;
  resolves_when: {
    kind: 'pr' | 'phase' | 'manual';
    ref: string;
    expected_by: string;
  };
}
export type ProjectionAllowlist = Record<string, AllowlistEntry>;

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

// ── Drift representation ──────────────────────────────────────────────────────────────
export interface DriftRecord {
  id: string;
  subject_kind: 'knowledge' | 'knowledge_edge';
  // human-readable field-level differences (column: live → expected).
  diffs: string[];
}

export interface AuditResult {
  ok: boolean; // true iff zero NON-allowlisted drift
  checkedNodes: number;
  checkedEdges: number;
  drift: DriftRecord[]; // non-allowlisted drift (the failures)
  allowed: DriftRecord[]; // drifted ids covered by the allowlist (reported, not failures)
}

// Map a live knowledge row to its STRUCTURAL snapshot (excludes embed_*, mirroring the fold
// output shape) so the deep-diff compares like-for-like.
function knowledgeRowToSnapshot(row: KnowledgeRow): KnowledgeRowSnapshotT {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    parent_id: row.parent_id,
    merged_from: row.merged_from,
    archived_at: row.archived_at,
    proposed_by_ai: row.proposed_by_ai,
    approval_status: row.approval_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

function edgeRowToSnapshot(row: EdgeRow): KnowledgeEdgeRowSnapshotT {
  return {
    id: row.id,
    from_knowledge_id: row.from_knowledge_id,
    to_knowledge_id: row.to_knowledge_id,
    relation_type: row.relation_type,
    weight: row.weight,
    created_by: row.created_by as Record<string, unknown>,
    reasoning: row.reasoning,
    created_at: row.created_at,
    archived_at: row.archived_at,
  };
}

// Normalise a value for stable deep-equality: Dates → epoch ms, everything else via JSON. The
// snapshot shapes hold scalars / nullable scalars / string[] / a Date pair (+ created_by jsonb
// on edges), so JSON-with-Date-coercion is a faithful structural compare.
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    // Sort keys so the downstream JSON.stringify is ORDER-INSENSITIVE: a jsonb object
    // (e.g. created_by) whose keys come back from Postgres in a different order than the
    // fold built them must NOT read as drift. (CodeRabbit/augment MAJOR — key-order
    // false-positive would make the B3 gate spuriously exit 1.)
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = normalize(obj[k]);
    return out;
  }
  return value;
}

// Deep-diff two snapshots field by field; return human-readable "col: live → expected" lines.
// `live` may be null (the live row is absent but the fold produced one) and `expected` may be
// null (the fold says the row should NOT exist but a live row is present) — both are drift.
function diffSnapshots(
  live: Record<string, unknown> | null,
  expected: Record<string, unknown> | null,
): string[] {
  if (live === null && expected === null) return [];
  if (live === null) return ['<row>: absent → fold-produced (projection missing a row)'];
  if (expected === null) return ['<row>: present → fold-null (stale row not in event log)'];
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(live), ...Object.keys(expected)]);
  for (const k of keys) {
    const a = JSON.stringify(normalize(live[k]));
    const b = JSON.stringify(normalize(expected[k]));
    if (a !== b) diffs.push(`${k}: ${a} → ${b}`);
  }
  return diffs;
}

/**
 * Re-derive fold(events) for every live knowledge + knowledge_edge id and deep-diff against
 * the live row. Returns the AuditResult (non-allowlisted drift makes ok=false). READ-ONLY —
 * writes nothing. Importable so the DB test drives it against the testcontainer.
 *
 * NOTE: this checks every LIVE row. A fold that produces a row with NO live counterpart (a
 * projection that should exist but doesn't) is out of scope for the live-row scan — the
 * rebuild path covers materialization; the auditor's job is "does each live row match its
 * log". (The allowlist + DB test exercise both present→null and value drift.)
 */
export async function auditProjection(
  db: DbLike,
  allowlist: ProjectionAllowlist = {},
): Promise<AuditResult> {
  const drift: DriftRecord[] = [];
  const allowed: DriftRecord[] = [];

  // ── nodes ──
  const nodes = await db.select().from(knowledge);
  for (const row of nodes) {
    const expected = await gatherAndFoldKnowledgeNode(db, row.id);
    const diffs = diffSnapshots(
      knowledgeRowToSnapshot(row),
      expected as Record<string, unknown> | null,
    );
    if (diffs.length > 0) {
      const rec: DriftRecord = { id: row.id, subject_kind: 'knowledge', diffs };
      (allowlist[row.id] ? allowed : drift).push(rec);
    }
  }

  // ── edges ──
  const edges = await db.select().from(knowledge_edge);
  for (const row of edges) {
    const expected = await gatherAndFoldKnowledgeEdge(db, row.id);
    const diffs = diffSnapshots(edgeRowToSnapshot(row), expected as Record<string, unknown> | null);
    if (diffs.length > 0) {
      const rec: DriftRecord = { id: row.id, subject_kind: 'knowledge_edge', diffs };
      (allowlist[row.id] ? allowed : drift).push(rec);
    }
  }

  return {
    ok: drift.length === 0,
    checkedNodes: nodes.length,
    checkedEdges: edges.length,
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
      `audit:projection — checked ${result.checkedNodes} node(s) + ${result.checkedEdges} edge(s).`,
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

// ops:projection — event-sourcing drift check. Not a CI gate.
//
// For every live projection row, re-derive the expected structural snapshot by folding that id's
// events in memory through the same gather helpers the IO shells use, then deep-diff it against the
// live row. A difference means the projection and its source-of-truth event log disagree.
//
// The auditor must re-derive without writing: the shell writes the fold through, so comparing after
// a rebuild would be tautological. Both paths share the same read→fold, so the audit can also catch a
// gather bug that corrupts the live write.
//
// Not in the test chain: it needs a populated database. Against an empty testcontainer it is
// trivially clean, and against imperatively-created rows it false-positives every row. It is a
// standalone prod-clone tool; its DB test seeds a coherent fixture, then mutates a row out of band.
//
// Allowlisted ids are reported as ALLOWED, not failures. See ops-projection-allowlist.json.

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

export type { AllowlistEntry, DriftRecord, ProjectionAllowlist };

const ALLOWLIST_PATH = resolve(
  fileURLToPath(new URL('./ops-projection-allowlist.json', import.meta.url)),
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
  ok: boolean;
  checkedNodes: number;
  checkedEdges: number;
  checkedGoals: number;
  checkedMistakeVariants: number;
  checkedLearningItems: number;
  checkedArtifacts: number;
  checkedQuestionBlocks: number;
  checkedItemCalibrations: number;
  drift: DriftRecord[]; // non-allowlisted failures
  allowed: DriftRecord[]; // reported, not failures
}

/**
 * Re-derive fold(events) for every live row and deep-diff against the live row. Read-only; the
 * registry loop means a new projection kind extends the audit without a new branch here.
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
    checkedItemCalibrations: checked.item_calibration?.checked ?? 0,
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
      `ops:projection — checked ${result.checkedNodes} node(s) + ${result.checkedEdges} edge(s) + ${result.checkedGoals} goal(s) + ${result.checkedMistakeVariants} mistake_variant(s) + ${result.checkedLearningItems} learning_item(s) + ${result.checkedArtifacts} artifact(s) + ${result.checkedQuestionBlocks} question_block(s) + ${result.checkedItemCalibrations} item_calibration(s).`,
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
          'is intentional, add the id to scripts/ops-projection-allowlist.json with a ' +
          'reason + resolves_when.',
      );
    }
  }

  if (!result.ok) process.exit(1);
}

// CLI-gate: only run as the entry point so the DB test can import auditProjection without side
// effects.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[ops-projection] failed:', err);
      process.exit(1);
    });
}

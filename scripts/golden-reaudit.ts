// YUK-548 (worklist #5, Q4b / component 7) — retained-golden RE-AUDIT: re-fold a frozen golden's
// events with the CURRENT reducer/gather and diff against the golden's IMPERATIVE rows.
//
// This is the NON-TAUTOLOGICAL leg (register line 673). The golden ROW is the imperative path's
// frozen output (captured under the gate-certified OLD code); this re-fold runs the PRESENT foldX. A
// post-flip reducer/gather change that no longer reproduces the imperative row surfaces as DRIFT — a
// genuine cross-check, because the reference is never a re-interpretation of the current fold.
//
// TRIGGER: run whenever `src/core/projections/**` or the `src/server/projections/gather.ts` branch of
// an ALREADY-ON entity changes (a pre-PR checklist item — see docs/design/… §7; the register's
// "reducer-code-hash-triggered" is landed as a path-triggered manual gate, n=1 sufficient; hash
// automation left optional). PURE — no DB (folds the golden's own captured events in memory).
//
// CLI:
//   pnpm audit:golden --kind=goal   # re-fold the latest scripts/golden/goal-*.json; exit 1 on drift

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { foldArtifact } from '@/core/projections/artifact';
import type { FoldEvent } from '@/core/projections/fold-event';
import { foldGoal } from '@/core/projections/goal';
import { foldKnowledgeNode } from '@/core/projections/knowledge';
import { foldKnowledgeEdge } from '@/core/projections/knowledge_edge';
import { foldLearningItem } from '@/core/projections/learning_item';
import { foldMistakeVariant } from '@/core/projections/mistake_variant';
import { foldQuestionBlock } from '@/core/projections/question_block';
import type { KnowledgeEdgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { ProjectionKind } from '@/server/projections/entity-registry';
import { diffSnapshots } from '@/server/projections/snapshot-diff';
import type { GoldenSnapshot } from './capture-golden';
import { parseKindArg } from './projection-kind-arg';

// Revive ISO-8601 date strings → Date so the reducers (created_at.getTime()) + diffSnapshots (Date
// equality) compare like-for-like against the fold's Date output.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function dateReviver(_key: string, value: unknown): unknown {
  return typeof value === 'string' && ISO_DATE.test(value) ? new Date(value) : value;
}

export function parseGolden(text: string): GoldenSnapshot {
  const parsed = JSON.parse(text, dateReviver) as Omit<GoldenSnapshot, 'capturedAt'> & {
    capturedAt: string | Date;
  };
  // capturedAt contract repair (review CR4): the FULL-TREE reviver is load-bearing for rows/events
  // (K3 doctrine — a per-key allowlist risks missing a nested date key and breaking the fold's
  // .getTime() calls), but it also revives this ONE top-level metadata field, which GoldenSnapshot
  // types as `string`. Restore it so string consumers (e.g. capture-golden's `.slice(0, 10)`) hold.
  const capturedAt =
    typeof parsed.capturedAt === 'string' ? parsed.capturedAt : parsed.capturedAt.toISOString();
  return { ...parsed, capturedAt };
}

// Re-fold one golden id with the CURRENT reducer. edge folds against the golden live-edge mesh.
function foldGoldenRow(
  kind: ProjectionKind,
  id: string,
  events: FoldEvent[],
  mesh: KnowledgeEdgeRowSnapshotT[],
): Record<string, unknown> | null {
  switch (kind) {
    case 'knowledge':
      return foldKnowledgeNode(id, events) as Record<string, unknown> | null;
    case 'knowledge_edge':
      return foldKnowledgeEdge(id, events, mesh) as Record<string, unknown> | null;
    case 'goal':
      return foldGoal(id, events) as Record<string, unknown> | null;
    case 'mistake_variant':
      return foldMistakeVariant(id, events) as Record<string, unknown> | null;
    case 'learning_item':
      return foldLearningItem(id, events) as Record<string, unknown> | null;
    case 'artifact':
      return foldArtifact(id, events) as Record<string, unknown> | null;
    case 'question_block':
      return foldQuestionBlock(id, events) as Record<string, unknown> | null;
    default: {
      // Exhaustiveness backstop (review O4): tsconfig lacks noImplicitReturns, so a missing case
      // would silently return undefined — which diffSnapshots does NOT guard (only null) and would
      // TypeError on Object.keys(undefined). Make a new ProjectionKind a compile error here.
      const _exhaustive: never = kind;
      throw new Error(`foldGoldenRow: unhandled ProjectionKind ${String(_exhaustive)}`);
    }
  }
}

export interface GoldenReauditResult {
  kind: ProjectionKind;
  checked: number;
  drifted: { id: string; diffs: string[] }[];
}

/**
 * Re-fold every golden id with the current reducer and diff against the golden imperative row.
 * PURE — no DB. Any diff = a post-flip reducer/gather regression.
 */
export function reauditGolden(golden: GoldenSnapshot): GoldenReauditResult {
  const events = golden.events;
  // edge fold needs the live topology mesh — the golden's own live (archived_at IS NULL) edge rows.
  const mesh =
    golden.kind === 'knowledge_edge'
      ? (Object.values(golden.rows).filter(
          (r) => r.archived_at === null,
        ) as unknown as KnowledgeEdgeRowSnapshotT[])
      : [];

  const drifted: { id: string; diffs: string[] }[] = [];
  for (const [id, goldenRow] of Object.entries(golden.rows)) {
    const folded = foldGoldenRow(golden.kind, id, events, mesh);
    const diffs = diffSnapshots(goldenRow, folded);
    if (diffs.length > 0) drifted.push({ id, diffs });
  }
  return { kind: golden.kind, checked: Object.keys(golden.rows).length, drifted };
}

const GOLDEN_DIR = resolve(fileURLToPath(new URL('./golden', import.meta.url)));

// Find the most recent golden file for `kind` (files are `<kind>-YYYY-MM-DD.json`, so lexical max = latest).
function latestGoldenPath(kind: ProjectionKind): string | null {
  let files: string[];
  try {
    files = readdirSync(GOLDEN_DIR);
  } catch {
    return null;
  }
  const matches = files.filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.json')).sort();
  const latest = matches.at(-1);
  return latest ? resolve(GOLDEN_DIR, latest) : null;
}

function main(): void {
  const kind = parseKindArg('golden-reaudit');
  const path = latestGoldenPath(kind);
  if (!path) {
    console.error(
      `[golden-reaudit] no golden captured for ${kind} (scripts/golden/${kind}-*.json). Run pnpm capture:golden --kind=${kind} before flipping it.`,
    );
    process.exit(2);
  }
  // Friendly failure (review O6): a corrupt/unreadable golden should print a clear pointer for this
  // pre-PR checklist CLI, not a raw stack trace.
  let golden: GoldenSnapshot;
  try {
    golden = parseGolden(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(
      `[golden-reaudit] failed to read/parse ${path} — re-capture it (pnpm capture:golden --kind=${kind}):`,
      err,
    );
    process.exit(2);
  }
  const result = reauditGolden(golden);

  console.log(`golden-reaudit — ${kind}: re-folded ${result.checked} row(s) from ${path}`);
  if (result.drifted.length === 0) {
    console.log('CLEAN — the current reducer reproduces every golden imperative row.');
    process.exit(0);
  }
  console.log(`\nDRIFT — ${result.drifted.length} row(s) the current fold no longer reproduces:`);
  for (const d of result.drifted) {
    console.log(`  - ${d.id}:`);
    for (const line of d.diffs) console.log(`      ${line}`);
  }
  console.log(
    '\nA post-flip reducer/gather change broke fold==imperative for these rows. Either the change is a\n' +
      'regression (revert/fix it), or it is an INTENTIONAL model change — in which case re-capture the\n' +
      'golden (pnpm capture:golden) AFTER re-verifying the new imperative rows are correct.',
  );
  process.exit(1);
}

// CLI-gate: only run as the CLI entry point so the DB test can import reauditGolden. Path-resolved
// form (review O5 — matches audit-projection.ts): robust to a transpiled .js filename too.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

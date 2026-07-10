// YUK-548 (worklist #5, Q4b / component 7) — retained-golden CAPTURE: freeze an entity's IMPERATIVE
// live rows + its event log as an INDEPENDENT reference artifact, BEFORE flipping that entity ON.
//
// WHY (register line 673, the non-tautological leg the Q4a sweep can NOT provide). Once an entity is
// ON, re-folding with the SAME gather is tautologically self-consistent — it cannot prove the reducer
// is still correct after a later change. The golden closes that gap: the golden ROW is the IMPERATIVE
// path's output (mapped straight off the live table, NOT the fold), frozen as data. The flip B3 gate
// guarantees fold == imperative row AT capture, so the golden is a certified-correct baseline. A later
// reducer/gather change is caught by re-folding the golden EVENTS and diffing against the golden
// IMPERATIVE row (scripts/golden-reaudit.ts) — non-tautological because the reference is imperative,
// captured under the OLD (gate-certified) code, never a re-interpretation of the current fold.
//
// This is NOT a runtime mechanism (Q1): it is a one-time OFFLINE snapshot + an offline re-fold, not a
// request-path double-write. Run it against a PROD-CLONE that has cleared the entity's B3 gate.
//
// CLI:
//   pnpm capture:golden --kind=goal    # writes scripts/golden/goal-<YYYY-MM-DD>.json

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, inArray, or } from 'drizzle-orm';

import type { FoldEvent } from '@/core/projections/fold-event';
import { type Db, type Tx, db } from '@/db/client';
import {
  artifact,
  event,
  goal,
  knowledge,
  knowledge_edge,
  learning_item,
  mistake_variant,
  question_block,
} from '@/db/schema';
import type { ProjectionKind } from '@/server/projections/entity-registry';
import { edgeRowToSnapshot, rowToFoldEvent } from '@/server/projections/gather';
import {
  artifactLiveRowToSnapshot,
  goalLiveRowToSnapshot,
  knowledgeLiveRowToSnapshot,
  learningItemLiveRowToSnapshot,
  mistakeVariantLiveRowToSnapshot,
  questionBlockLiveRowToSnapshot,
} from '@/server/projections/parity';
import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
// PURE re-fold + diff (no side effects; golden-reaudit's CLI is import-gated so importing it here
// never runs it, and its import of THIS module is type-only — no runtime cycle). Used by main() for
// the birth self-verification (review K4).
import { reauditGolden } from './golden-reaudit';
import { parseKindArg } from './projection-kind-arg';

export interface GoldenSnapshot {
  kind: ProjectionKind;
  capturedAt: string;
  rowCount: number;
  // id → the IMPERATIVE row snapshot (from the live table, NOT the fold).
  rows: Record<string, Record<string, unknown>>;
  // the gather-input SUPERSET (raw FoldEvents) — the reducer filters by id internally, so a superset
  // is correct + lets the offline re-fold reconstruct any id without a DB.
  events: FoldEvent[];
}

// Cross-entity event actions any gather pulls beyond its own subject_kind (Q2 reverse-index / Q3
// merge / accept-rate chains). A GENEROUS superset — the pure reducers filter by id + action, so extra
// rows are harmless, and this avoids re-implementing each gather's per-kind predicate here.
const CROSS_REF_ACTIONS = [
  'rate',
  'correct',
  'propose',
  'generate',
  'experimental:knowledge_merge',
  'experimental:variant_verify',
  'experimental:edit_question_block_structured',
] as const;

// Per-kind TYPED row capture (review O8): each branch selects from its CONCRETE table so the
// drizzle-inferred row type flows straight into the exported parity mapper — no `as never` bridge.
// A renamed / re-typed schema column now fails HERE at compile time instead of silently producing a
// corrupted golden baseline. The mappers are the SAME field-picks the parity assert / audit use, so
// the golden shape matches what the fold reproduces.
async function captureRowSnapshots(
  tx: Db | Tx,
  kind: ProjectionKind,
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  switch (kind) {
    case 'knowledge': {
      const rows = await tx.select().from(knowledge);
      for (const r of rows) out[r.id] = knowledgeLiveRowToSnapshot(r) as Record<string, unknown>;
      return out;
    }
    case 'knowledge_edge': {
      const rows = await tx.select().from(knowledge_edge);
      for (const r of rows) out[r.id] = edgeRowToSnapshot(r) as Record<string, unknown>;
      return out;
    }
    case 'goal': {
      const rows = await tx.select().from(goal);
      for (const r of rows) out[r.id] = goalLiveRowToSnapshot(r) as Record<string, unknown>;
      return out;
    }
    case 'mistake_variant': {
      const rows = await tx.select().from(mistake_variant);
      for (const r of rows)
        out[r.id] = mistakeVariantLiveRowToSnapshot(r) as Record<string, unknown>;
      return out;
    }
    case 'learning_item': {
      const rows = await tx.select().from(learning_item);
      for (const r of rows) out[r.id] = learningItemLiveRowToSnapshot(r) as Record<string, unknown>;
      return out;
    }
    case 'artifact': {
      const rows = await tx.select().from(artifact);
      for (const r of rows) out[r.id] = artifactLiveRowToSnapshot(r) as Record<string, unknown>;
      return out;
    }
    case 'question_block': {
      const rows = await tx.select().from(question_block);
      for (const r of rows)
        out[r.id] = questionBlockLiveRowToSnapshot(r) as Record<string, unknown>;
      return out;
    }
    default: {
      // Exhaustiveness backstop (review O4/O10 pattern): tsconfig lacks noImplicitReturns, so a
      // missing case would silently return undefined for a future kind.
      const _exhaustive: never = kind;
      throw new Error(`captureRowSnapshots: unhandled ProjectionKind ${String(_exhaustive)}`);
    }
  }
}

/**
 * Capture the golden snapshot for `kind`: every live row → its imperative snapshot, plus the
 * gather-input event superset. READ-ONLY. Pure data (the CLI writes it to disk; the test drives it
 * against the testcontainer without a file).
 *
 * Both reads run inside ONE REPEATABLE READ tx (review K4 — birth-snapshot consistency): a concurrent
 * write landing between the row read and the event read would otherwise freeze a golden whose rows
 * and events disagree (a dirty baseline that false-DRIFTs forever). Takes a `Db` (not Tx) because it
 * OWNS the snapshot transaction.
 */
export async function captureGolden(db: Db, kind: ProjectionKind): Promise<GoldenSnapshot> {
  return db.transaction(
    async (tx) => {
      const rows = await captureRowSnapshots(tx, kind);

      const eventRows = await tx
        .select()
        .from(event)
        .where(or(eq(event.subject_kind, kind), inArray(event.action, [...CROSS_REF_ACTIONS])));
      const events = eventRows.map(rowToFoldEvent);

      return {
        kind,
        capturedAt: new Date().toISOString(),
        rowCount: Object.keys(rows).length,
        rows,
        events,
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}

const GOLDEN_DIR = resolve(fileURLToPath(new URL('./golden', import.meta.url)));

export function goldenPath(kind: ProjectionKind, date: string): string {
  return resolve(GOLDEN_DIR, `${kind}-${date}.json`);
}

async function main(): Promise<void> {
  const kind = parseKindArg('capture-golden');
  // YUK-600（review-760 P2 同前置）：foldGoal 经活 registry 归一 subject_id。这个 CLI 有 DB，
  // 先水合——否则含 custom 科目 goal 的库在下面的 birth reaudit（离线 re-fold）里必然假 DRIFT
  // 被拒写。golden-reaudit 本体无 DB，见其文件头的水合前置标注。
  await hydrateSubjectRegistryFromDb(db);
  const golden = await captureGolden(db, kind);

  // Birth self-verification (review K4): a golden is only a valid baseline if the CURRENT fold
  // reproduces every imperative row (the fold==imperative certification this capture rides on).
  // Re-fold the in-memory golden BEFORE writing (reauditGolden is pure — no DB, no side effects);
  // a drifted capture is REFUSED — never commit a golden that fails its own reaudit at birth.
  const birth = reauditGolden(golden);
  if (birth.drifted.length > 0) {
    console.error(
      `[capture-golden] REFUSING to write: ${birth.drifted.length}/${birth.checked} ${kind} row(s) do not re-fold to their imperative snapshot — this clone has NOT cleared the B3 gate (fold == imperative row) for this entity. Run B3_GATE_CONFIRM_CLONE=1 pnpm b3:gate, resolve the drift, then re-run pnpm capture:golden --kind=${kind}.`,
    );
    for (const d of birth.drifted.slice(0, 10)) {
      console.error(`  - ${d.id}: ${d.diffs.join('; ')}`);
    }
    if (birth.drifted.length > 10) {
      console.error(`  … and ${birth.drifted.length - 10} more`);
    }
    process.exit(1);
  }

  const date = golden.capturedAt.slice(0, 10); // YYYY-MM-DD
  const path = goldenPath(kind, date);
  mkdirSync(dirname(path), { recursive: true });
  // biome-formatted 2-space JSON (never python json.dump) — committed evidence artifact.
  writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(
    `[capture-golden] wrote ${golden.rowCount} ${kind} row(s) + ${golden.events.length} event(s) → ${path} (birth reaudit CLEAN)`,
  );
}

// CLI-gate: only run as the CLI entry point so the DB test can import captureGolden. Path-resolved
// form (review O5 — matches audit-projection.ts): robust to a transpiled .js filename too.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[capture-golden] failed:', err);
      process.exit(1);
    });
}

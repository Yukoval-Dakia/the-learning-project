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
import { type Db, db } from '@/db/client';
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

// Map ONE live row of `kind` to its IMPERATIVE snapshot (the exported live-row mappers — the same
// field-pick the parity assert / audit use, so the golden shape matches what the fold reproduces).
function rowToSnapshot(
  kind: ProjectionKind,
  row: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case 'knowledge':
      return knowledgeLiveRowToSnapshot(row as never) as Record<string, unknown>;
    case 'knowledge_edge':
      return edgeRowToSnapshot(row as never) as Record<string, unknown>;
    case 'goal':
      return goalLiveRowToSnapshot(row as never) as Record<string, unknown>;
    case 'mistake_variant':
      return mistakeVariantLiveRowToSnapshot(row as never) as Record<string, unknown>;
    case 'learning_item':
      return learningItemLiveRowToSnapshot(row as never) as Record<string, unknown>;
    case 'artifact':
      return artifactLiveRowToSnapshot(row as never) as Record<string, unknown>;
    case 'question_block':
      return questionBlockLiveRowToSnapshot(row as never) as Record<string, unknown>;
  }
}

const KIND_TABLE = {
  knowledge,
  knowledge_edge,
  goal,
  mistake_variant,
  learning_item,
  artifact,
  question_block,
} as const;

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
      const liveRows = (await tx.select().from(KIND_TABLE[kind])) as Record<string, unknown>[];
      const rows: Record<string, Record<string, unknown>> = {};
      for (const row of liveRows) {
        rows[row.id as string] = rowToSnapshot(kind, row);
      }

      const eventRows = await tx
        .select()
        .from(event)
        .where(or(eq(event.subject_kind, kind), inArray(event.action, [...CROSS_REF_ACTIONS])));
      const events = eventRows.map(rowToFoldEvent);

      return {
        kind,
        capturedAt: new Date().toISOString(),
        rowCount: liveRows.length,
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

// CLI-gate: only run as the CLI entry point so the DB test can import captureGolden.
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('capture-golden.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[capture-golden] failed:', err);
      process.exit(1);
    });
}

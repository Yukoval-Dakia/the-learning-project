// One-shot data migration: clamp every persisted question_block `structured` / `figures` bbox into
// the canonical 0-1 normalized BBox range.
//
// Why: the question_block genesis backfill snapshots the live row and validates it at writeEvent's
// parse barrier. The canonical BBox schema requires 0-1 component bounds plus sum refinements
// (x + width <= 1, y + height <= 1), so a legacy overflowing bbox makes the backfill fail loud.
// The extraction-side fix prevents new overflow; this sweep repairs existing rows so the backfill
// seeds clean and the SoT-flip gate can go green.
//
// It walks each block's structured tree (node bbox and handwriting bbox) plus figures[].source_bbox
// and applies the same clamp as flat8ToBBox: clamp x/y to 0-1, then cap width/height at 1-x / 1-y.
// A legal bbox clamps to itself and is left untouched, so re-runs write zero rows.
//
// Out of scope: page_spans[].bbox (the snapshot's PageSpan is deliberately tolerant), crop_refs
// staleness (a separate fold-clean fix), the question table, and non-finite/malformed bboxes
// (left for owner inspection rather than fabricated). Needs a populated DB: run on a prod-clone
// before backfillQuestionBlockGenesis.

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { asc, eq, gt } from 'drizzle-orm';
import { type BBoxLike, clampBBox } from '@/core/schema/bbox-utils';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import { type Db, type Tx, db } from '@/db/client';
import { question_block } from '@/db/schema';

type DbLike = Db | Tx;

export interface SweepCounts {
  scanned: number; // total question_block rows read
  rowsWithOverflow: number; // rows with >= 1 out-of-range bbox (the rows updated in --apply)
  bboxesClamped: number; // total individual bboxes clamped across all rows
  applied: boolean; // true = persisted; false = dry run
}

// Keyset page size. Each question_block row carries a potentially deep recursive `structured` tree
// (every node has prompt_text/options/answers/analysis + nested sub_questions) plus a `figures[]`
// array, so the per-row footprint is large; loading the whole table at once can exhaust memory on a
// prod-scale block count. Page by the text primary key to bound peak memory.
const SWEEP_BATCH_SIZE = 500;

// A bbox is a clamp candidate only when it is a well-formed FINITE numeric quad. §P3 scope is the
// OVERFLOW case (finite-but-out-of-range); a non-finite / missing-component bbox is a SEPARATE
// corruption this sweep does not fabricate-repair — return false and leave it untouched.
function isFiniteBBox(b: unknown): b is BBoxLike {
  if (b == null || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    Number.isFinite(o.x) &&
    Number.isFinite(o.y) &&
    Number.isFinite(o.width) &&
    Number.isFinite(o.height)
  );
}

function bboxChanged(a: BBoxLike, c: BBoxLike): boolean {
  return a.x !== c.x || a.y !== c.y || a.width !== c.width || a.height !== c.height;
}

// Walk a StructuredQuestion node in place: clamp the node's optional bbox + every handwriting bbox,
// then recurse into sub_questions. Returns the number of bboxes actually clamped (legal ones are
// left byte-identical and not counted).
function sweepStructuredNode(node: StructuredQuestionT): number {
  let count = 0;
  if (isFiniteBBox(node.bbox)) {
    const clamped = clampBBox(node.bbox);
    if (bboxChanged(node.bbox, clamped)) {
      node.bbox = clamped;
      count += 1;
    }
  }
  // extraction_evidence.handwriting[].bbox is a REQUIRED refined BBox on each HandwriteInfo, so an
  // overflow here ALSO fails the strict backfill parse — clamp it too (it rides inside `structured`).
  for (const h of node.extraction_evidence?.handwriting ?? []) {
    if (isFiniteBBox(h.bbox)) {
      const clamped = clampBBox(h.bbox);
      if (bboxChanged(h.bbox, clamped)) {
        h.bbox = clamped;
        count += 1;
      }
    }
  }
  for (const sub of node.sub_questions ?? []) {
    count += sweepStructuredNode(sub);
  }
  return count;
}

// Clamp every figure's required source_bbox in place. Returns the number of bboxes clamped.
function sweepFigures(figures: FigureRefT[]): number {
  let count = 0;
  for (const fig of figures) {
    if (isFiniteBBox(fig.source_bbox)) {
      const clamped = clampBBox(fig.source_bbox);
      if (bboxChanged(fig.source_bbox, clamped)) {
        fig.source_bbox = clamped;
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Clamp every persisted question_block structured/figure bbox into [0,1] (sum-safe). DRY RUN by
 * default (reads + reports, writes nothing); pass `{ apply: true }` to persist. Only rows with at
 * least one out-of-range bbox are touched, and within a touched row only the column(s) that actually
 * changed are written. Idempotent. Returns { scanned, rowsWithOverflow, bboxesClamped, applied }.
 * Exported so the DB test drives it against the testcontainer; the CLI main()/auto-run only fires as
 * the entry point.
 */
export async function sweepQuestionBlockBBox(
  db: DbLike,
  opts: { apply?: boolean } = {},
): Promise<SweepCounts> {
  const apply = opts.apply ?? false;
  // Keyset-paginate by the text primary key instead of loading every block at once (see
  // SWEEP_BATCH_SIZE). The clamp only ever rewrites `structured` / `figures` (never `id`), so the id
  // ordering is stable across an --apply pass: already-swept rows have id <= cursor and never
  // reappear, so the sweep stays single-scan, idempotent, and crash-safe (partial progress is fine
  // on re-run). Narrow the select to the columns the clamp reads/writes to further bound the
  // per-row footprint.
  let scanned = 0;
  let rowsWithOverflow = 0;
  let bboxesClamped = 0;
  let cursor: string | null = null;
  for (;;) {
    const batch = await db
      .select({
        id: question_block.id,
        structured: question_block.structured,
        figures: question_block.figures,
      })
      .from(question_block)
      .where(cursor === null ? undefined : gt(question_block.id, cursor))
      .orderBy(asc(question_block.id))
      .limit(SWEEP_BATCH_SIZE);
    if (batch.length === 0) break;
    scanned += batch.length;
    for (const row of batch) {
      // Deep-clone so a dry run never mutates anything observable and an apply writes a fresh object.
      const structured = row.structured
        ? (structuredClone(row.structured) as StructuredQuestionT)
        : null;
      const figures = structuredClone(row.figures ?? []) as FigureRefT[];
      const structuredCount = structured ? sweepStructuredNode(structured) : 0;
      const figuresCount = sweepFigures(figures);
      const rowCount = structuredCount + figuresCount;
      if (rowCount === 0) continue; // legal row — left untouched
      rowsWithOverflow += 1;
      bboxesClamped += rowCount;
      if (apply) {
        // Set ONLY the column(s) that actually changed (mirror normalize-edge-created-by: never
        // rewrite a column whose value is unchanged).
        const set: { structured?: StructuredQuestionT | null; figures?: FigureRefT[] } = {};
        if (structuredCount > 0) set.structured = structured;
        if (figuresCount > 0) set.figures = figures;
        await db.update(question_block).set(set).where(eq(question_block.id, row.id));
      }
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < SWEEP_BATCH_SIZE) break;
  }
  return { scanned, rowsWithOverflow, bboxesClamped, applied: apply };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const counts = await sweepQuestionBlockBBox(db, { apply });
  const mode = apply ? 'APPLY' : 'DRY RUN';
  const suffix = apply ? ' (persisted).' : ' (no writes — re-run with --apply to persist).';
  console.log(
    `[sweep-question-block-bbox] ${mode} — scanned ${counts.scanned} block(s), ${counts.rowsWithOverflow} with out-of-range bbox, ${counts.bboxesClamped} bbox(es) clamped${suffix}`,
  );
}

// CLI-gate: only run + exit as the CLI entry point so the DB test can import the fn without the
// top-level run firing.
if (
  typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('sweep-question-block-bbox.ts')
) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[sweep-question-block-bbox] failed:', err);
      process.exit(1);
    });
}

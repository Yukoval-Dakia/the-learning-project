// YUK-471 W3-D §P3 (YUK-502) — one-shot data migration: clamp every persisted question_block
// `structured` / `figures` bbox into the canonical 0-1 normalized BBox range.
//
// WHY. The B3 SoT-flip for question_block is only safe when `pnpm audit:projection` is CLEAN —
// every block's fold(events) == row. The genesis backfill (scripts/backfill-genesis-events.ts,
// backfillQuestionBlockGenesis) writes the anchor `experimental:genesis` event for each pre-Wave3
// (event-LESS) block by snapshotting the live row and validating it at writeEvent's parse barrier
// against the strict QuestionBlockRowSnapshot. `structured` (the recursive StructuredQuestion tree)
// and `figures` (FigureRef[]) reuse the canonical schemas, whose BBox carries the 0-1 component
// bounds PLUS the sum refinements (`x + width <= 1`, `y + height <= 1`). A LEGACY block whose stored
// bbox overflows those bounds throws at the barrier → the backfill fails loud (batched: one error
// lists every bad id). The C1-δ flat8ToBBox fix (tencent_mark_parser.ts) prevents NEW overflow rows;
// this sweep repairs the EXISTING ones so the backfill seeds clean and the flip gate goes green.
//
// WHAT. Read every question_block row, walk its `structured` tree (each node's optional `bbox` AND
// each `extraction_evidence.handwriting[].bbox` — both are refined BBox in the strict schema, so an
// overflow in either fails the backfill) plus every `figures[].source_bbox`, and clamp any
// out-of-range bbox using the SAME rule C1-δ's flat8ToBBox now applies to new extractions:
//   x = clamp01(x); y = clamp01(y);
//   width  = min(clamp01(width),  1 - x);
//   height = min(clamp01(height), 1 - y);
// A LEGAL bbox (all components in [0,1] AND sum-safe) clamps to itself → it is left untouched.
//
// OUT OF SCOPE (deliberately not swept):
//   - `page_spans[].bbox` — the strict snapshot's PageSpan is deliberately TOLERANT (raw 4-number
//     object, NOT the 0-1 refined BBox), so a coordinate envelope never false-rejects and never
//     needs clamping (genesis.ts §PageSpan).
//   - `crop_refs` staleness — a SEPARATE, optional fold-clean fix (design §9 item 3), NOT a flip
//     blocker. The W3-D runbook §"Ref disambiguation" warns against conflating the two.
//   - the `question` table (its own structured/figures columns) — NOT a Wave3 fold entity; not in
//     the audit:projection / backfill-genesis set.
//   - a NON-finite / structurally-malformed bbox (missing component) — that is a different
//     corruption the §P3 overflow sweep does not fabricate-repair; it is left for owner inspection
//     (isFiniteBBox gate below).
//
// IDEMPOTENT. The clamp is a fixed point on legal bboxes and on its own output
// (clamp(clamp(b)) == clamp(b), since clamp01 is idempotent and min(width', 1-x) == width' once
// width' <= 1-x), so a row is updated only when at least one of its bboxes is genuinely out of
// range. A re-run after a clean pass clamps zero bboxes and writes zero rows.
//
// NOT in the `pnpm test` chain — it needs a populated DB. Run it on a prod-CLONE (and on prod)
// BEFORE backfillQuestionBlockGenesis / before flipping the question_block SoT. CI coverage is the
// DB test (src/server/projections/sweep-question-block-bbox.db.test.ts).
//
// CLI:
//   pnpm normalize:qb-bbox            # DRY RUN — report what WOULD be clamped, write nothing
//   pnpm normalize:qb-bbox --apply    # clamp + persist

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import { type Db, type Tx, db } from '@/db/client';
import { question_block } from '@/db/schema';
import { asc, eq, gt } from 'drizzle-orm';

type DbLike = Db | Tx;

// The numeric bbox quad as persisted in jsonb. Pre-clamp it may be out of [0,1] / sum-unsafe.
interface BBoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

// clamp01 — mirror tencent_mark_parser.ts:72 EXACTLY (non-finite -> 0). KEEP IN SYNC with flat8ToBBox.
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

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

// clampBBox — the SAME rule C1-δ's flat8ToBBox (tencent_mark_parser.ts:64-69) applies to NEW
// extractions: x/y clamped to [0,1]; width/height clamped to [0,1] THEN capped at 1-x / 1-y so the
// result satisfies the canonical BBox refine (x+width<=1, y+height<=1). Sum-safe + idempotent.
// KEEP IN SYNC with flat8ToBBox.
function clampBBox(b: BBoxLike): BBoxLike {
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  return {
    x,
    y,
    width: Math.min(clamp01(b.width), 1 - x),
    height: Math.min(clamp01(b.height), 1 - y),
  };
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

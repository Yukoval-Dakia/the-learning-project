// YUK-1528 — pure, deterministic paginator. Packs measured blocks (heights in mm) into page
// bodies. Same input, same pages: no DOM, no randomness, no clock.
//
// Rules, kept deliberately simple:
//   - blocks go top to bottom with a fixed gap; a block that fits is placed whole;
//   - a block marked keepWithNext (question header, stem before its answer) moves to the next page
//     unless the start of the following block fits with it;
//   - a writing panel that does not fit may be cut across pages. No piece is shorter than
//     MIN_SEGMENT_MM; pieces are numbered 1..n (the region's segment_index);
//   - any other block taller than a whole page body is a layout_overflow.
// A flow is a run of pages with one orientation. A passage flow repeats its passage in the left
// column of each of its pages; the passage itself must fit one column.
//
// YUK-1538 — a passage taller than one column continues across pages instead of overflowing.
// The measure stage reports the legal cut offsets inside the column (line/block starts); the
// paginator packs each page's left column with the longest run between cuts that fits, then the
// renderer shows that vertical slice. Pages the right column still needs after the passage ran
// out carry a "see earlier pages" pointer instead; pages with passage left after the right
// column finished keep coming with no right-column placements. Short passages keep the old
// per-page repeat exactly.

import {
  BLOCK_GAP_MM,
  BODY_SAFETY_MM,
  MIN_SEGMENT_MM,
  PASSAGE_CONTINUED_HINT_MM,
  type SheetOrientation,
} from './worksheet-geometry';

export interface MeasuredBlock {
  key: string;
  /** Whole block height, label and full panel included. */
  heightMm: number;
  /** Writing panels only: the label row above the panel (with its gap) and the panel height. */
  split: { labelMm: number; panelMm: number } | null;
  keepWithNext: boolean;
}

export interface FlowInput {
  key: string;
  orientation: SheetOrientation;
  /** Passage flows: the left column block (item header + passage) and its height. */
  passage: {
    key: string;
    heightMm: number;
    /**
     * Sorted legal cut positions inside the column (mm from its top), ending at heightMm.
     * Present only when the column is split; a short passage repeats whole per page.
     */
    cutOffsetsMm?: readonly number[];
  } | null;
  blocks: MeasuredBlock[];
}

export interface PlacedSegment {
  /** 1-based piece number across pages. */
  index: number;
  panelMm: number;
  /** Continues from the previous page. */
  continued: boolean;
  /** Continues on the next page. */
  continues: boolean;
}

export interface PagePlacement {
  key: string;
  /** Set for writing panels (also when not cut: one piece, index 1). */
  segment: PlacedSegment | null;
}

export interface LaidOutPage {
  flowKey: string;
  orientation: SheetOrientation;
  passageKey: string | null;
  /**
   * Which slice of the passage column this page's left column shows: `repeat` (short passage,
   * the whole column again), `slice` (continued passage: [offsetMm, offsetMm+heightMm)), or
   * `seeEarlier` (right column still going, passage already finished — a pointer note).
   * `roomMm` is the full column height the paginator packed against, so the renderer can tell
   * how much slack a slice left for a continuation hint.
   */
  passage?: {
    kind: 'repeat' | 'slice' | 'seeEarlier';
    offsetMm: number;
    heightMm: number;
    roomMm: number;
    /** This slice is not the last — the passage continues on a later page. */
    continues?: boolean;
  };
  placements: PagePlacement[];
}

export type PaginateResult =
  | { ok: true; pages: LaidOutPage[] }
  | { ok: false; reason: 'layout_overflow'; key: string };

/**
 * Whether `block` can start in `room` mm under the same rules the loop below applies: whole, or
 * (writing panels) cut with both pieces at least MIN_SEGMENT_MM.
 */
function canStartIn(block: MeasuredBlock, room: number): boolean {
  if (block.heightMm <= room) return true;
  if (!block.split) return false;
  const first = room - block.split.labelMm;
  return first >= MIN_SEGMENT_MM && block.split.panelMm - first >= MIN_SEGMENT_MM;
}

export function paginate(
  flows: readonly FlowInput[],
  bodyMm: Readonly<Record<SheetOrientation, number>>,
): PaginateResult {
  const pages: LaidOutPage[] = [];

  for (const flow of flows) {
    const height = bodyMm[flow.orientation] - BODY_SAFETY_MM;
    const cuts = flow.passage?.cutOffsetsMm;
    const splits = flow.passage != null && cuts != null && cuts.length > 1;
    if (flow.passage && flow.passage.heightMm > height && !splits) {
      return { ok: false, reason: 'layout_overflow', key: flow.passage.key };
    }
    // Left-column slices for a long passage: each page takes the longest run of legal cuts
    // that fits one column. `slices[i]` is [offsetMm, offsetMm+heightMm) on left-column page i.
    const slices: { offsetMm: number; heightMm: number; continues: boolean }[] = [];
    if (splits && flow.passage && cuts) {
      let offset = 0;
      let cursor = 0;
      while (offset < flow.passage.heightMm) {
        let end = offset;
        while (cursor < cuts.length) {
          const cut = cuts[cursor] ?? 0;
          // Continuation pages reserve room for the 接上页 hint above the slice and (unless the
          // slice ends at the last cut) the 下页续 hint below it.
          const topHint = offset > 0 ? PASSAGE_CONTINUED_HINT_MM : 0;
          const bottomHint = cut < flow.passage.heightMm ? PASSAGE_CONTINUED_HINT_MM : 0;
          const limit = height - topHint - bottomHint;
          if (cut - offset > limit) break;
          end = cut;
          cursor += 1;
        }
        if (end <= offset) {
          // A single indivisible box taller than the column: honest overflow, never clipped.
          return { ok: false, reason: 'layout_overflow', key: flow.passage.key };
        }
        slices.push({ offsetMm: offset, heightMm: end - offset, continues: false });
        offset = end;
      }
      for (const [index, slice] of slices.entries()) {
        slice.continues = index < slices.length - 1;
      }
    }
    const newPage = (): LaidOutPage => ({
      flowKey: flow.key,
      orientation: flow.orientation,
      passageKey: flow.passage?.key ?? null,
      placements: [],
    });
    const flowStart = pages.length;
    let page = newPage();
    pages.push(page);
    let used = 0;
    const open = () => {
      page = newPage();
      pages.push(page);
      used = 0;
    };
    const current = () => page;
    const gap = () => (current().placements.length > 0 ? BLOCK_GAP_MM : 0);
    const place = (key: string, heightMm: number, segment: PlacedSegment | null) => {
      used += gap() + heightMm;
      current().placements.push({ key, segment });
    };

    for (const [index, block] of flow.blocks.entries()) {
      // Keep chains are transitive: a header goes here only if the header, every stem chained
      // after it, and the start of the answer block that ends the chain all fit; otherwise the
      // whole chain moves to the next page together.
      const keepsHere = (room: number) => {
        let chainMm = 0;
        let tail = index;
        while (flow.blocks[tail]?.keepWithNext && flow.blocks[tail + 1]) {
          chainMm += (tail > index ? BLOCK_GAP_MM : 0) + (flow.blocks[tail]?.heightMm ?? 0);
          tail += 1;
        }
        const end = flow.blocks[tail];
        if (tail === index || !end) return true;
        return chainMm <= room && canStartIn(end, room - chainMm - BLOCK_GAP_MM);
      };

      if (!block.split) {
        const room = height - used - gap();
        if (block.heightMm <= room && keepsHere(room)) {
          place(block.key, block.heightMm, null);
          continue;
        }
        if (current().placements.length > 0) open();
        if (block.heightMm > height) {
          return { ok: false, reason: 'layout_overflow', key: block.key };
        }
        place(block.key, block.heightMm, null);
        continue;
      }

      const { labelMm, panelMm } = block.split;
      if (labelMm + MIN_SEGMENT_MM > height) {
        return { ok: false, reason: 'layout_overflow', key: block.key };
      }
      const pieces: { page: LaidOutPage; placement: PagePlacement }[] = [];
      let remaining = panelMm;
      while (remaining > 0) {
        const room = height - used - gap() - labelMm;
        let take: number;
        if (remaining <= room) {
          take = remaining;
        } else {
          const canCutHere = room >= MIN_SEGMENT_MM && remaining - room >= MIN_SEGMENT_MM;
          if (!canCutHere && current().placements.length > 0) {
            open();
            continue;
          }
          // On an empty page (or a good cut point): fill the room, but leave the last piece at
          // least MIN_SEGMENT_MM.
          take = canCutHere
            ? room
            : Math.max(MIN_SEGMENT_MM, Math.min(room, remaining - MIN_SEGMENT_MM));
        }
        const segment: PlacedSegment = {
          index: pieces.length + 1,
          panelMm: take,
          continued: pieces.length > 0,
          continues: false,
        };
        place(block.key, labelMm + take, segment);
        const placements = current().placements;
        const placement = placements[placements.length - 1];
        if (placement) pieces.push({ page: current(), placement });
        remaining -= take;
        if (remaining > 0) open();
      }
      for (const [pieceIndex, piece] of pieces.entries()) {
        if (piece.placement.segment) {
          piece.placement.segment.continues = pieceIndex < pieces.length - 1;
        }
      }
    }

    // Assign each page its left-column slice (or repeat/see-earlier marker) for this flow, and
    // keep emitting pages while the passage outlasts the right column — no fake question, no
    // dropped paragraph.
    if (flow.passage) {
      for (const [index, laidOut] of pages.slice(flowStart).entries()) {
        laidOut.passage = !splits
          ? { kind: 'repeat', offsetMm: 0, heightMm: flow.passage.heightMm, roomMm: height }
          : (() => {
              const slice = slices[index];
              return slice
                ? {
                    kind: 'slice',
                    offsetMm: slice.offsetMm,
                    heightMm: slice.heightMm,
                    roomMm: height,
                    continues: slice.continues,
                  }
                : { kind: 'seeEarlier', offsetMm: 0, heightMm: 0, roomMm: height };
            })();
      }
      while (splits && pages.length - flowStart < slices.length) {
        const extra: LaidOutPage = {
          flowKey: flow.key,
          orientation: flow.orientation,
          passageKey: flow.passage.key,
          placements: [],
        };
        const slice = slices[pages.length - flowStart];
        if (slice) {
          extra.passage = {
            kind: 'slice',
            offsetMm: slice.offsetMm,
            heightMm: slice.heightMm,
            roomMm: height,
            continues: slice.continues,
          };
        }
        pages.push(extra);
      }
    }
  }

  return { ok: true, pages };
}

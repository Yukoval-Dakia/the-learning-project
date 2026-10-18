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

import {
  BLOCK_GAP_MM,
  BODY_SAFETY_MM,
  MIN_SEGMENT_MM,
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
  passage: { key: string; heightMm: number } | null;
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
    if (flow.passage && flow.passage.heightMm > height) {
      return { ok: false, reason: 'layout_overflow', key: flow.passage.key };
    }
    const newPage = (): LaidOutPage => ({
      flowKey: flow.key,
      orientation: flow.orientation,
      passageKey: flow.passage?.key ?? null,
      placements: [],
    });
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
      const next = flow.blocks[index + 1];
      // A header or a stem stays on this page only if what follows can start right after it.
      const keepsHere = (room: number) =>
        !block.keepWithNext || !next || canStartIn(next, room - block.heightMm - BLOCK_GAP_MM);

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
  }

  return { ok: true, pages };
}

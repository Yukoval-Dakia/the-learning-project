// YUK-1823 — one issued presentation, ready for a page in another capability: the shell hands
// this to the page, so the page draws a question without depending on Practice. Custom (sandbox)
// blocks give null: the host page would also have to run their load and verify steps.
import type { ReactNode } from 'react';
import type { ResponseSlotT, SlotResponseT } from '@/core/schema/assessment';
import { customBlocksOf } from './custom-sandbox';
import { boundSlots, entriesForSubmit } from './envelope';
import {
  PresentationBlocks,
  type PresentationBlocksProps,
  parsePresentation,
} from './PresentationBlocks';

export interface IssuedBlocks {
  /** Select and blank slots may be left empty; they are handed in as active blanks. */
  blankableSlotIds: ReadonlySet<string>;
  entriesForSubmit: (
    slots: readonly ResponseSlotT[],
    entries: readonly SlotResponseT[],
  ) => SlotResponseT[];
  render: (props: Omit<PresentationBlocksProps, 'presentation'>) => ReactNode;
}

export function readIssuedBlocks(raw: unknown): IssuedBlocks | null {
  const presentation = parsePresentation(raw);
  if (!presentation || customBlocksOf(presentation).length > 0) return null;
  return {
    blankableSlotIds: new Set(
      boundSlots(presentation)
        .filter((bound) => bound.response_class === 'select' || bound.response_class === 'blank')
        .map((bound) => bound.slot_id),
    ),
    entriesForSubmit: (slots, entries) => entriesForSubmit(presentation, slots, entries),
    render: (props) => <PresentationBlocks {...props} presentation={presentation} />,
  };
}

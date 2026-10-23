// Stick-to-bottom for the message scroller, owned by the scroller's DOM node (a ref callback), not
// by an effect. While the reader is at (or within 48px of) the bottom, a row added or removed, the
// last row growing (streaming text, late Markdown, images) or the scroller resizing keeps the end
// in view; once they scroll up to read, nothing pulls them down. The learner's own send re-sticks.

import { useState } from 'react';

const STICK_SLACK_PX = 48;

export interface StickToBottom {
  /** Ref callback for the scroll container; its first child is the row list. */
  attach: (scroller: HTMLElement | null) => (() => void) | undefined;
  /** Bring the stream back to the end and keep it there (the learner just sent). */
  stick: () => void;
}

function createStickToBottom(): StickToBottom {
  let sticky = true;
  let scrollToEnd: (() => void) | null = null;

  function attach(scroller: HTMLElement | null) {
    if (!scroller) return undefined;
    const end = () => {
      scroller.scrollTop = scroller.scrollHeight;
    };
    scrollToEnd = end;
    const onScroll = () => {
      sticky = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_SLACK_PX;
    };
    const list = scroller.firstElementChild;
    const resize = new ResizeObserver((entries) => {
      const rows = list?.children;
      const lastRow = rows?.item(rows.length - 1) ?? null;
      const keepsEnd = (target: Element) =>
        target === scroller ||
        !lastRow ||
        target === lastRow ||
        Boolean(lastRow.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (sticky && entries.some((entry) => keepsEnd(entry.target))) {
        end();
        return;
      }
      // An older row changed size without a scroll event; re-read where the reader is.
      onScroll();
    });
    resize.observe(scroller);
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) if (added instanceof Element) resize.observe(added);
        for (const removed of record.removedNodes)
          if (removed instanceof Element) resize.unobserve(removed);
      }
      if (sticky) end();
    });
    if (list) {
      for (const child of list.children) resize.observe(child);
      mutations.observe(list, { childList: true });
    }
    scroller.addEventListener('scroll', onScroll, { passive: true });
    sticky = true;
    end();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      mutations.disconnect();
      resize.disconnect();
      if (scrollToEnd === end) scrollToEnd = null;
    };
  }

  return {
    attach,
    stick: () => {
      sticky = true;
      scrollToEnd?.();
    },
  };
}

export function useStickToBottom(): StickToBottom {
  const [controller] = useState(createStickToBottom);
  return controller;
}

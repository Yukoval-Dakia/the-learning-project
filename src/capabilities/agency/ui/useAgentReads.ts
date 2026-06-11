// Local visual state for the read-only "AI 观察" board (YUK-294).
//
// The ONLY stateful interaction on the board is purely visual and purely local:
//   - collapse/expand the Today block (open),
//   - mark fresh notes as read (read set).
// Both persist in localStorage. ZERO backend writes — there is no accept/dismiss
// (only-read iron rule). Today block + full-screen view share the same keys/hook.
//
// SSR hydration guard (mirrors review/page.tsx): server render + client first
// frame must agree, so defaults are open=false / read=empty, and localStorage is
// read in a mount-time useEffect that then setState. One frame of "collapsed,
// no reads" before hydration is acceptable.

import { useCallback, useEffect, useState } from 'react';
import { isFresh } from './derive';

export const AN_LS_OPEN = 'loom-annotes-open'; // '1' = expanded, default collapsed
export const AN_LS_READ = 'loom-annotes-read'; // JSON string[] of read note ids

interface ReadableNote {
  id: string;
  created_at: Date | string | number;
}

export interface AgentReads {
  open: boolean;
  toggleOpen: () => void;
  isUnread: (note: ReadableNote) => boolean;
  markAllRead: (notes: ReadableNote[]) => void;
  // For callers that want an unread count without re-deriving freshness.
  unreadCount: (notes: ReadableNote[]) => number;
}

export function useAgentReads(now: Date): AgentReads {
  const [open, setOpen] = useState(false);
  const [readSet, setReadSet] = useState<Set<string>>(() => new Set());

  // Mount-after-read: hydrate both from localStorage post-mount only.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setOpen(window.localStorage.getItem(AN_LS_OPEN) === '1');
    try {
      const raw = window.localStorage.getItem(AN_LS_READ);
      if (raw) setReadSet(new Set(JSON.parse(raw) as string[]));
    } catch {
      window.localStorage.removeItem(AN_LS_READ);
    }
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(AN_LS_OPEN, next ? '1' : '0');
      }
      return next;
    });
  }, []);

  const isUnread = useCallback(
    (note: ReadableNote) => isFresh(note.created_at, now) && !readSet.has(note.id),
    [readSet, now],
  );

  const markAllRead = useCallback((notes: ReadableNote[]) => {
    setReadSet((prev) => {
      const next = new Set(prev);
      for (const n of notes) next.add(n.id);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(AN_LS_READ, JSON.stringify([...next]));
      }
      return next;
    });
  }, []);

  const unreadCount = useCallback(
    (notes: ReadableNote[]) => notes.filter((n) => isUnread(n)).length,
    [isUnread],
  );

  return { open, toggleOpen, isUnread, markAllRead, unreadCount };
}

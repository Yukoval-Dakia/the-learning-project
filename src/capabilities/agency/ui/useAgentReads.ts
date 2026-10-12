// Local visual state for the read-only "AI 观察" board (YUK-294).
//
// The ONLY stateful interaction on the board is purely visual and purely local:
//   - collapse/expand the Today block (open),
//   - mark fresh notes as read (read set).
// Both persist in localStorage. ZERO backend writes — there is no accept/dismiss
// (only-read iron rule). Today block + full-screen view share the same keys/hook.
//
// SSR hydration: both values come from a small localStorage-backed store read through
// useSyncExternalStore. The server snapshot (and the hydration pass) is open=false /
// read=empty, so server HTML and the client's first frame agree; React then re-renders with
// the stored values. Snapshots are cached per raw storage string so they stay referentially
// stable. Writes go through the toggle/mark commands, which notify every mounted consumer on
// this page; the `storage` event keeps other tabs in step.

import { useCallback, useSyncExternalStore } from 'react';
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

const EMPTY_READ: ReadonlySet<string> = new Set();

// Client-only: subscribe and the client snapshots never run during SSR (the server snapshots
// are constants), so nothing user-specific is shared across server requests.
const listeners = new Set<() => void>();
let readCache: { raw: string | null; set: ReadonlySet<string> } = { raw: null, set: EMPTY_READ };

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(ev: StorageEvent) {
  if (ev.key === null || ev.key === AN_LS_OPEN || ev.key === AN_LS_READ) notify();
}

/** null = stored value is corrupt. */
function parseReadSet(raw: string | null): ReadonlySet<string> | null {
  if (!raw) return EMPTY_READ;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed as string[]) : null;
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    // Attach-time repair of a corrupt read list (the old mount-time read did the same).
    if (parseReadSet(window.localStorage.getItem(AN_LS_READ)) === null) {
      window.localStorage.removeItem(AN_LS_READ);
    }
    window.addEventListener('storage', onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

function getOpenSnapshot() {
  return window.localStorage.getItem(AN_LS_OPEN) === '1';
}

function getServerOpen() {
  return false;
}

function getReadSnapshot(): ReadonlySet<string> {
  const raw = window.localStorage.getItem(AN_LS_READ);
  if (raw !== readCache.raw) readCache = { raw, set: parseReadSet(raw) ?? EMPTY_READ };
  return readCache.set;
}

function getServerRead(): ReadonlySet<string> {
  return EMPTY_READ;
}

export function useAgentReads(now: Date): AgentReads {
  const open = useSyncExternalStore(subscribe, getOpenSnapshot, getServerOpen);
  const readSet = useSyncExternalStore(subscribe, getReadSnapshot, getServerRead);

  const toggleOpen = useCallback(() => {
    window.localStorage.setItem(AN_LS_OPEN, getOpenSnapshot() ? '0' : '1');
    notify();
  }, []);

  const isUnread = useCallback(
    (note: ReadableNote) => isFresh(note.created_at, now) && !readSet.has(note.id),
    [readSet, now],
  );

  const markAllRead = useCallback((notes: ReadableNote[]) => {
    const next = new Set(getReadSnapshot());
    for (const n of notes) next.add(n.id);
    window.localStorage.setItem(AN_LS_READ, JSON.stringify([...next]));
    notify();
  }, []);

  const unreadCount = useCallback(
    (notes: ReadableNote[]) => notes.filter((n) => isUnread(n)).length,
    [isUnread],
  );

  return { open, toggleOpen, isUnread, markAllRead, unreadCount };
}

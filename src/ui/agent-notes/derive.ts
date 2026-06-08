// Pure derive helpers for the read-only "AI 观察" board (YUK-294).
//
// The board consumes the real AgentNote shape (created_at, expires_at, refs[],
// caused_by_event_id) — NOT the prototype's pre-baked fresh/when/ttl/evidence
// fields. These helpers derive those display facets from the real timestamps so
// nothing parses a relative-time string. `now` is injected for testability.

import type { ReactNode } from 'react';
import { createElement } from 'react';

// created_at arrives over JSON as an ISO string but is a Date in-process; accept
// both and coerce, mirroring formatRelTime's tolerance.
export type DateLike = Date | string | number;

function toDate(input: DateLike): Date {
  return input instanceof Date ? input : new Date(input);
}

const DAY_MS = 86_400_000;
const FRESH_MS = DAY_MS; // 24h
const TTL_SOON_MS = 2 * DAY_MS; // 48h

// A note is "fresh" (eligible to seed the unread dot) when created within 24h.
export function isFresh(createdAt: DateLike, now: Date): boolean {
  const d = toDate(createdAt);
  if (Number.isNaN(d.getTime())) return false;
  return now.getTime() - d.getTime() < FRESH_MS;
}

export interface TtlInfo {
  text: string;
  // soon = expires within 48h → render as the amber 临期 badge.
  soon: boolean;
}

// Relativise expires_at. Returns null for a non-expiring note. "约 N 小时后过期"
// under a day, "约 N 天后过期" otherwise. Already-expired notes are filtered
// server-side, but guard defensively (negative delta → soon, "即将过期").
export function deriveTtl(expiresAt: string | undefined, now: Date): TtlInfo | null {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return null;
  const delta = exp.getTime() - now.getTime();
  const soon = delta < TTL_SOON_MS;
  if (delta <= 0) return { text: '即将过期', soon: true };
  const hours = Math.round(delta / 3_600_000);
  const text = hours < 24 ? `约 ${hours} 小时后过期` : `约 ${Math.round(delta / DAY_MS)} 天后过期`;
  return { text, soon };
}

export type DayGroup = 'today' | 'yesterday' | 'earlier';

export interface DayGroupInfo {
  group: DayGroup;
  label: string;
}

// Group by the REAL local calendar day of created_at (not by parsing a relative
// string). today / 昨天 / 更早, compared at local midnight boundaries.
export function dayGroupOf(createdAt: DateLike, now: Date): DayGroupInfo {
  const d = toDate(createdAt);
  if (Number.isNaN(d.getTime())) return { group: 'earlier', label: '更早' };
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const deltaDays = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS);
  if (deltaDays <= 0) return { group: 'today', label: '今天' };
  if (deltaDays === 1) return { group: 'yesterday', label: '昨天' };
  return { group: 'earlier', label: '更早' };
}

// Light inline markdown: **bold** and `code` only (notes are 1–2 sentences).
// Returns ReactNodes; does NOT pull in a markdown library. Unclosed tokens are
// left as plain text (the regex only matches balanced pairs).
export function anInlineMd(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(createElement('b', { key: k++, className: 'an-body-b' }, tok.slice(2, -2)));
    } else {
      out.push(createElement('code', { key: k++, className: 'an-code' }, tok.slice(1, -1)));
    }
    last = m.index + tok.length;
    m = re.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export interface EvidenceRef {
  // Display label (id or a short form).
  label: string;
  // Navigation target, or null when the ref kind is not navigable.
  href: string | null;
  // Original ref kind for any kind-specific affordance.
  kind: string;
}

// Minimal note shape resolveEvidence needs — refs[] plus the event-column
// fallback. Keeps the helper decoupled from the full AgentNote import.
export interface EvidenceSource {
  refs: Array<{ kind: string; id: string }>;
  caused_by_event_id?: string;
}

// Resolve the single evidence entry point for a note.
//   - refs[] takes priority. kind==='event' → /events/:id (navigable). Other
//     ref kinds render their id as text with no href (not navigable here).
//   - refs empty → fall back to caused_by_event_id (the event column surfaced by
//     readAllAgentNotes), treated as an event ref.
//   - nothing → null (no evidence affordance rendered).
export function resolveEvidence(note: EvidenceSource): EvidenceRef | null {
  const first = note.refs[0];
  if (first) {
    if (first.kind === 'event') {
      return { label: first.id, href: `/events/${first.id}`, kind: 'event' };
    }
    return { label: first.id, href: null, kind: first.kind };
  }
  if (note.caused_by_event_id) {
    return {
      label: note.caused_by_event_id,
      href: `/events/${note.caused_by_event_id}`,
      kind: 'event',
    };
  }
  return null;
}

// Pure derive helpers for the read-only "AI 观察" board (YUK-294).
//
// The board consumes the real AgentNote shape (created_at, expires_at, refs[],
// caused_by_event_id) — NOT the prototype's pre-baked fresh/when/ttl/evidence
// fields. These helpers derive those display facets from the real timestamps so
// nothing parses a relative-time string. `now` is injected for testability.

import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { BoardAgentNote } from './types';

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

export type AgentNoteGroupState = 'open' | 'resolved' | 'unknown';
export type AgentNoteAttention = 'high' | 'medium' | 'resolved';

export interface AgentNoteGroup {
  key: string;
  notes: BoardAgentNote[];
  latest: BoardAgentNote;
  primary_ref: BoardAgentNote['refs'][number] | null;
  resolution_state: AgentNoteGroupState;
  attention: AgentNoteAttention;
  run_count: number;
  expires_at?: string;
}

function noteGroupKey(note: BoardAgentNote): string {
  const primary = note.refs[0];
  if (primary) return `${note.signal_kind}|${primary.kind}|${primary.id}`;
  if (note.source_task_run_id) return `${note.signal_kind}|run|${note.source_task_run_id}`;
  if (note.caused_by_event_id) return `${note.signal_kind}|event|${note.caused_by_event_id}`;
  return `${note.signal_kind}|note|${note.id}`;
}

function groupState(notes: BoardAgentNote[]): AgentNoteGroupState {
  const states = notes.flatMap((note) => note.refs.map((ref) => ref.resolution_state));
  if (states.includes('open')) return 'open';
  if (states.length > 0 && states.every((state) => state === 'resolved')) return 'resolved';
  return 'unknown';
}

function groupAttention(notes: BoardAgentNote[], state: AgentNoteGroupState): AgentNoteAttention {
  if (state === 'resolved') return 'resolved';
  const hasHardFailure = notes.some((note) =>
    /verification\s+failed|校验失败/i.test(note.summary_md),
  );
  const maxConfidence = Math.max(...notes.map((note) => note.confidence ?? 0));
  return hasHardFailure || notes.length >= 4 || maxConfidence >= 0.9 ? 'high' : 'medium';
}

/**
 * Collapse repeated observations by signal + primary subject while preserving
 * every underlying run for expandable audit evidence. Notes without a subject
 * are grouped by their real run id (or triggering event) instead.
 */
export function groupAgentNotes(notes: BoardAgentNote[]): AgentNoteGroup[] {
  const sorted = [...notes].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const buckets = new Map<string, BoardAgentNote[]>();
  for (const note of sorted) {
    const key = noteGroupKey(note);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(note);
    else buckets.set(key, [note]);
  }

  return [...buckets.entries()].map(([key, items]) => {
    const latest = items[0];
    const state = groupState(items);
    const expiries = items
      .flatMap((note) => (note.expires_at ? [note.expires_at] : []))
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    const runs = new Set(
      items.map((note) => note.source_task_run_id ?? note.caused_by_event_id ?? note.id),
    );
    return {
      key,
      notes: items,
      latest,
      primary_ref: latest.refs[0] ?? null,
      resolution_state: state,
      attention: groupAttention(items, state),
      run_count: runs.size,
      ...(expiries[0] ? { expires_at: expiries[0] } : {}),
    };
  });
}

/** Keep stored machine templates out of learner copy without mutating history. */
export function humanAgentNoteSummary(
  note: Pick<BoardAgentNote, 'signal_kind' | 'summary_md'>,
  state: AgentNoteGroupState = 'unknown',
): string {
  if (note.signal_kind === 'question_pool_gap') {
    return state === 'resolved'
      ? '先前有候选题未通过校验；这个知识点现在已有可用练习。'
      : '有候选题未通过校验，这个知识点仍需要补充可用练习。';
  }

  const latinCount = (note.summary_md.match(/[A-Za-z]/g) ?? []).length;
  const hanCount = (note.summary_md.match(/[\u3400-\u9fff]/g) ?? []).length;
  if (latinCount > hanCount * 2 && latinCount > 16) {
    return 'AI 留下了一条协作观察；展开后可查看发生时间与真实证据。';
  }

  const cleaned = note.summary_md
    .replace(/spike:[\w:-]+/gi, '相关知识点')
    .replace(/\b[a-z0-9]{20,}\b/gi, '相关记录')
    .replace(/\b[A-Z][A-Za-z]+Task\b/g, 'AI 工作')
    .replace(/\b(?:needs_review|verification|failed)\b/gi, '待复核')
    .trim();
  return cleaned || 'AI 留下了一条协作观察。';
}

export function agentNoteGroupSummary(group: AgentNoteGroup): string {
  if (group.latest.signal_kind !== 'question_pool_gap') {
    return humanAgentNoteSummary(group.latest, group.resolution_state);
  }

  const usableCount = Math.max(
    ...group.notes.flatMap((note) => note.refs.map((ref) => ref.usable_question_count ?? 0)),
  );
  if (group.resolution_state === 'resolved') {
    return `${group.run_count} 次候选题校验没有进入题池；当前已有 ${usableCount} 道可用练习，历史记录仍可追溯。`;
  }
  return `${group.run_count} 次候选题校验没有进入题池，这个知识点目前仍缺可用练习。`;
}

export function agentNoteRunLabel(
  note: Pick<BoardAgentNote, 'signal_kind' | 'summary_md'>,
): string {
  if (/verification\s+failed|校验失败/i.test(note.summary_md)) return '未通过校验';
  if (/needs_review|待复核/i.test(note.summary_md)) return '等待人工复核';
  if (note.signal_kind === 'question_pool_gap') return '未进入可用题池';
  return '已记录';
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
  refs: Array<{ kind: string; id: string; label?: string }>;
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
      return {
        label: first.label ?? '事件证据',
        href: `/events/${encodeURIComponent(first.id)}`,
        kind: 'event',
      };
    }
    if (first.kind === 'knowledge') {
      return {
        label: first.label ?? '相关知识点',
        href: `/knowledge/${encodeURIComponent(first.id)}`,
        kind: 'knowledge',
      };
    }
    if (first.kind === 'question') {
      return {
        label: first.label ?? '相关题目',
        href: `/questions/${encodeURIComponent(first.id)}`,
        kind: 'question',
      };
    }
    return { label: first.label ?? '相关证据', href: null, kind: first.kind };
  }
  if (note.caused_by_event_id) {
    return {
      label: '事件证据',
      href: `/events/${encodeURIComponent(note.caused_by_event_id)}`,
      kind: 'event',
    };
  }
  return null;
}

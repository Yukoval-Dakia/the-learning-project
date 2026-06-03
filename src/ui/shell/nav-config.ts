// Loom app-shell nav config — ported from docs/design/loom-prototype/app.jsx
// (NAV / MOBILE_NAV / TITLES / parseRoute) and mapped onto the Next App Router
// surfaces that actually exist under app/(app)/*. The prototype's hash router
// (`#base/param`) becomes real routes via ROUTE_MAP; `activeFromPath` is the
// usePathname()-driven equivalent of the prototype's `navActive = base`.

import type { LoomIconName } from '@/ui/primitives/LoomIcon';

/** A single sidebar nav entry. */
export interface NavItem {
  /** Stable id; also the active-key matched by activeFromPath. */
  id: string;
  label: string;
  icon: LoomIconName;
  /** Optional count badge. Static placeholders for now (prototype parity). */
  count?: number;
}

/** A section header row in the sidebar nav (no link). */
export interface NavSection {
  section: string;
}

export type NavEntry = NavItem | NavSection;

export function isSection(entry: NavEntry): entry is NavSection {
  return 'section' in entry;
}

// Sidebar nav — two sections: 织造 (weaving: the active learning loop) and
// 整理 (organizing: the captured corpus). Counts are static placeholders that
// later slices will wire to real due/inbox/mistake totals.
export const NAV: NavEntry[] = [
  { section: '织造' },
  { id: 'today', label: '今日', icon: 'today' },
  { id: 'review', label: '复习', icon: 'review' },
  { id: 'record', label: '录入', icon: 'record' },
  { section: '整理' },
  { id: 'inbox', label: '收件箱', icon: 'inbox' },
  { id: 'mistakes', label: '错题', icon: 'mistakes' },
  // 题库 (questions) — 入口暂缺：/questions 路由尚未落地（codex 的 off-plan 实现
  // 已 park）。题库是 target-domain-model decision #4 计划内的 surface，待其专门
  // 的 redraw slice 落地时把这条 NavItem 加回（TITLES/ROUTE_MAP/PATH_ACTIVE 已就位）。
  // 现在不挂链接，避免点击 404。
  { id: 'items', label: '学习项', icon: 'items' },
  { id: 'knowledge', label: '知识', icon: 'knowledge' },
];

/** Mobile bottom bar: ≤5 core entries; `__more` opens the sidebar drawer. */
export const MOBILE_NAV: NavItem[] = [
  { id: 'today', label: '今日', icon: 'today' },
  { id: 'review', label: '复习', icon: 'review' },
  { id: 'record', label: '录入', icon: 'record' },
  { id: 'knowledge', label: '知识', icon: 'knowledge' },
  { id: '__more', label: '更多', icon: 'menu' },
];

/** Breadcrumb title for the topbar, keyed by active id / route base. */
export const TITLES: Record<string, string> = {
  today: '今日',
  review: '复习',
  record: '录入',
  inbox: '收件箱',
  mistakes: '错题',
  questions: '题库',
  items: '学习项',
  knowledge: '知识',
  coach: 'Coach',
  events: '事件链',
  'learning-sessions': '学习会话',
  notes: '笔记',
  'study-log': '学习日志',
};

/** Maps a nav id → the concrete App Router path to push. */
export const ROUTE_MAP: Record<string, string> = {
  today: '/today',
  review: '/review',
  record: '/record',
  inbox: '/inbox',
  mistakes: '/mistakes',
  questions: '/questions',
  items: '/learning-items',
  knowledge: '/knowledge',
};

// Ordered, longest-prefix-first so /learning-items wins over a bare /learning,
// and /learning-sessions is distinguished from /learning-items. Each tuple is
// [pathPrefix, activeId]. activeId doubles as the TITLES key.
const PATH_ACTIVE: Array<[string, string]> = [
  ['/learning-items', 'items'],
  ['/learning-sessions', 'learning-sessions'],
  ['/today', 'today'],
  ['/review', 'review'],
  ['/record', 'record'],
  ['/inbox', 'inbox'],
  ['/mistakes', 'mistakes'],
  ['/questions', 'questions'],
  ['/knowledge', 'knowledge'],
  ['/coach', 'coach'],
  ['/events', 'events'],
  ['/notes', 'notes'],
  ['/study-log', 'study-log'],
];

/**
 * usePathname() → active nav id. Returns '' when no surface matches (e.g. a
 * route with no sidebar entry), which simply leaves the sidebar with no active
 * highlight. The matched id is also the TITLES breadcrumb key.
 */
export function activeFromPath(pathname: string): string {
  for (const [prefix, id] of PATH_ACTIVE) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return id;
  }
  return '';
}

/**
 * Extracts a breadcrumb `param` segment (the prototype's `parseRoute().param`):
 * the path tail after the matched surface base, used to render the mono
 * `Loom / TITLE / <param>` trailing crumb on detail routes. Returns null when
 * the route is a bare index (no detail param).
 */
export function paramFromPath(pathname: string): string | null {
  for (const [prefix] of PATH_ACTIVE) {
    if (pathname.startsWith(`${prefix}/`)) {
      const tail = pathname.slice(prefix.length + 1);
      return tail.length > 0 ? tail : null;
    }
  }
  return null;
}

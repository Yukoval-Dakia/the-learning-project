// Loom app-shell nav config — ported from docs/design/loom-prototype/app.jsx
// (NAV / MOBILE_NAV / TITLES / parseRoute) and mapped onto the Next App Router
// surfaces that actually exist under app/(app)/*. The prototype's hash router
// (`#base/param`) becomes real routes via ROUTE_MAP; `activeFromPath` is the
// usePathname()-driven equivalent of the prototype's `navActive = base`.
//
// M4 review fix (YUK-319, codex P2)：已迁 SPA 的面（M1-M3 的 review/practice/
// record/knowledge/notes + M4 的 today/inbox）从本配置整体摘除——旧壳与 SPA
// 不同 origin，router.push 这些路径在 Next 侧是 404 死链。旧壳只剩整理区
// （mistakes/questions/items 及无侧栏入口的 coach/events 等），M5 拆整壳时
// 本文件随旧壳一起删除。

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

// Sidebar nav — the 织造 section (today/review/practice/record) and the
// inbox/knowledge entries are gone: those surfaces live in the SPA now. Only
// the 整理 (organizing) corpus pages remain in the old shell.
export const NAV: NavEntry[] = [
  { section: '整理' },
  { id: 'mistakes', label: '错题', icon: 'mistakes' },
  // 题库 (questions) — YUK-288 S1 已落地 /questions 列表 + 详情（只读侧）。位置按
  // 设计稿「错题与练习附近」落在「错题」后、「学习项」前（TITLES/ROUTE_MAP/
  // PATH_ACTIVE 早已就位）。
  { id: 'questions', label: '题库', icon: 'quiz' },
  { id: 'items', label: '学习项', icon: 'items' },
];

/** Mobile bottom bar: ≤5 core entries; `__more` opens the sidebar drawer. */
export const MOBILE_NAV: NavItem[] = [
  { id: 'mistakes', label: '错题', icon: 'mistakes' },
  { id: 'questions', label: '题库', icon: 'quiz' },
  { id: 'items', label: '学习项', icon: 'items' },
  { id: '__more', label: '更多', icon: 'menu' },
];

/** Breadcrumb title for the topbar, keyed by active id / route base. */
export const TITLES: Record<string, string> = {
  mistakes: '错题',
  questions: '题库',
  items: '学习项',
  coach: 'Coach',
  events: '事件链',
  'learning-sessions': '学习会话',
  'study-log': '学习日志',
};

/** Maps a nav id → the concrete App Router path to push. */
export const ROUTE_MAP: Record<string, string> = {
  mistakes: '/mistakes',
  questions: '/questions',
  items: '/learning-items',
};

// Ordered, longest-prefix-first so /learning-items wins over a bare /learning,
// and /learning-sessions is distinguished from /learning-items. Each tuple is
// [pathPrefix, activeId]. activeId doubles as the TITLES key.
const PATH_ACTIVE: Array<[string, string]> = [
  ['/learning-items', 'items'],
  ['/learning-sessions', 'learning-sessions'],
  ['/mistakes', 'mistakes'],
  ['/questions', 'questions'],
  ['/coach', 'coach'],
  ['/events', 'events'],
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

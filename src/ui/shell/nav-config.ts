// S13 (YUK-335 批次丙) — SPA 根壳 nav 配置。
//
// 设计源 docs/design/loom-refresh/project/app.jsx 的 NAV / MOBILE_NAV / TITLES /
// parseRoute。设计稿 9 项 nav（today/practice/record · inbox/mistakes/questions/
// items/knowledge）是 hash 路由 demo；这里只登记 **真实存在的 SPA 路由**（见
// web/src/router.tsx routeTree），避免死链 / 假入口（owner 红线：不 fabricate）。
//
// 取舍裁断（task S13 决策点）：
//   • mistakes / questions / items —— **省略（方案 a）**。SPA 无这三条路由（M5
//     teardown 后仅旧栈残留，新栈未接通）。渲为 placeholder（方案 b）会造死链 /
//     假入口，与 nav「点了就到」的语义相悖；省略更干净。三面随后续 M 在 SPA
//     接通后回填本配置即可。
//   • agent-notes（AI 观察）/ coach —— **加入**。二者是真实 SPA 面
//     （/agent-notes /coach），补足设计「整理」叙事的观察 / 周报入口。
//
// 路由耦合只经调用方注入的 navigate / pathname —— 本文件不 import 任何路由库
// （SPA 是 TanStack Router，shell 组件经 prop 注入；不 import next/navigation）。

import type { LoomIconName } from '@/ui/primitives/LoomIcon';

/** 单条侧栏 nav 项。 */
export interface NavItem {
  /** 稳定 id；也是 activeFromPath 匹配的 active-key。 */
  id: string;
  label: string;
  icon: LoomIconName;
  /** 该项指向的具体 SPA 路由（navigate 推入）。 */
  path: string;
}

/** 侧栏分组标题行（无链接）。 */
export interface NavSection {
  section: string;
}

export type NavEntry = NavItem | NavSection;

export function isSection(entry: NavEntry): entry is NavSection {
  return 'section' in entry;
}

// 侧栏 nav —— 设计两段（织造 / 整理），只含真实 SPA 路由。
export const NAV: NavEntry[] = [
  { section: '织造' },
  { id: 'today', label: '今日', icon: 'today', path: '/today' },
  { id: 'practice', label: '练习', icon: 'layers', path: '/practice' },
  { id: 'record', label: '录入', icon: 'record', path: '/record' },
  { section: '整理' },
  { id: 'inbox', label: '收件箱', icon: 'inbox', path: '/inbox' },
  { id: 'knowledge', label: '知识', icon: 'knowledge', path: '/knowledge' },
  // agent-notes / coach 是真实 SPA 面，补足设计「整理」段的观察 / 周报入口。
  { id: 'agent-notes', label: 'AI 观察', icon: 'eye', path: '/agent-notes' },
  { id: 'coach', label: 'Coach', icon: 'teach', path: '/coach' },
];

/** 移动底栏：≤5 核心入口；`__more` 开侧栏 drawer 而非导航。 */
export const MOBILE_NAV: NavItem[] = [
  { id: 'today', label: '今日', icon: 'today', path: '/today' },
  { id: 'practice', label: '练习', icon: 'layers', path: '/practice' },
  { id: 'record', label: '录入', icon: 'record', path: '/record' },
  { id: 'knowledge', label: '知识', icon: 'knowledge', path: '/knowledge' },
  { id: '__more', label: '更多', icon: 'menu', path: '' },
];

/** topbar 面包屑标题，按 active id / 路由 base 索引（设计 app.jsx TITLES）。 */
export const TITLES: Record<string, string> = {
  today: '今日',
  practice: '练习',
  record: '录入',
  inbox: '收件箱',
  knowledge: '知识',
  notes: '笔记',
  'agent-notes': 'AI 观察',
  coach: 'Coach',
  admin: 'Admin',
};

// 按最长前缀优先排序：/knowledge/$id 仍归 knowledge active，但 /notes/* 与
// /admin/* 各自命中自己的 base。每元组是 [pathPrefix, activeId]；activeId 同时
// 是 TITLES 的 key。
const PATH_ACTIVE: Array<[string, string]> = [
  ['/today', 'today'],
  ['/practice', 'practice'],
  ['/record', 'record'],
  ['/inbox', 'inbox'],
  ['/knowledge', 'knowledge'],
  ['/notes', 'notes'],
  ['/agent-notes', 'agent-notes'],
  ['/coach', 'coach'],
  ['/admin', 'admin'],
];

/**
 * pathname → active nav id（设计 app.jsx 的 navActive=base 等价物）。无 surface
 * 命中时返回 ''（侧栏无高亮，例如未登记 nav 的明细路由仍能显示）。命中的 id
 * 同时是 TITLES 面包屑 key。
 */
export function activeFromPath(pathname: string): string {
  for (const [prefix, id] of PATH_ACTIVE) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return id;
  }
  return '';
}

/**
 * 抽取面包屑 `param` 段（设计 parseRoute().param）：匹配 base 之后的路径尾，
 * 用于明细路由（/knowledge/$id、/notes/$id、/admin/runs）渲染 mono 尾 crumb。
 * 路由是 bare index（无明细段）时返回 null。
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

// YUK-329 — shell navigation projection。
//
// 页面路径、标题、active 归属、nav/search 可见性来自 kernel 的 UI_SURFACES；本文件
// 只保留 LoomIcon 这种纯视觉映射与 section flattening，避免再造一份路由表。

import { UI_SURFACES, matchUiSurface } from '@/kernel/ui-surfaces';
import type { LoomIconName } from '@/ui/primitives/LoomIcon';

/** 单条侧栏 nav 项。 */
export interface NavItem {
  id: string;
  label: string;
  icon: LoomIconName;
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

const SURFACE_ICONS: Record<string, LoomIconName> = {
  today: 'today',
  practice: 'layers',
  record: 'record',
  inbox: 'inbox',
  mistakes: 'mistakes',
  questions: 'quiz',
  drafts: 'review',
  knowledge: 'knowledge',
  'agent-notes': 'eye',
  coach: 'teach',
  'admin-runs': 'settings',
  'admin-cost': 'hash',
  'admin-failures': 'alert',
  'admin-subjects': 'knowledge',
  'admin-coverage-lattice': 'layers',
  'admin-conjecture-scores': 'sparkle',
};

function iconFor(id: string): LoomIconName {
  return SURFACE_ICONS[id] ?? 'arrow';
}

const navSurfaces = UI_SURFACES.filter((surface) => 'nav' in surface && surface.nav).sort(
  (left, right) => {
    if (!('nav' in left) || !left.nav || !('nav' in right) || !right.nav) return 0;
    const sectionOrder =
      left.nav.section === right.nav.section ? 0 : left.nav.section === '织造' ? -1 : 1;
    return sectionOrder || left.nav.order - right.nav.order;
  },
);

/** 侧栏 nav：section 与 item 均投影自 shipped surface inventory。 */
export const NAV: NavEntry[] = [];
let lastSection = '';
for (const surface of navSurfaces) {
  if (!('nav' in surface) || !surface.nav) continue;
  if (surface.nav.section !== lastSection) {
    lastSection = surface.nav.section;
    NAV.push({ section: lastSection });
  }
  NAV.push({
    id: surface.id,
    label: surface.title,
    icon: iconFor(surface.id),
    path: surface.route,
  });
}

/** 移动底栏：inventory 中声明 mobileOrder 的四个核心入口 + “更多”。 */
export const MOBILE_NAV: NavItem[] = UI_SURFACES.flatMap((surface) => {
  if (!('nav' in surface) || !surface.nav || !('mobileOrder' in surface.nav)) return [];
  return [
    {
      id: surface.id,
      label: surface.title,
      icon: iconFor(surface.id),
      path: surface.route,
      order: surface.nav.mobileOrder,
    },
  ];
})
  .sort((left, right) => left.order - right.order)
  .map(({ order: _order, ...item }) => item);
MOBILE_NAV.push({ id: '__more', label: '更多', icon: 'menu', path: '' });

export interface SearchPageItem extends NavItem {
  keywords: string;
}

/** 命令面板可直达的静态页面；动态详情不会生成无 id 的假入口。 */
export const SEARCH_PAGE_ITEMS: SearchPageItem[] = UI_SURFACES.flatMap((surface) => {
  if (!('search' in surface) || !surface.search) return [];
  return [
    {
      id: surface.id,
      label: surface.search.label,
      icon: iconFor(surface.id),
      path: surface.route,
      keywords: 'keywords' in surface.search ? surface.search.keywords : '',
    },
  ];
});

/** 搜索框可见承诺；与 CommandPalette 的实际两类 index 同源复用。 */
export const COMMAND_PALETTE_PLACEHOLDER = '搜索页面和知识节点…';

/** pathname → active nav key。未知路径返回空串，绝不伪装成“今日”。 */
export function activeFromPath(pathname: string): string {
  return matchUiSurface(pathname)?.surface.activeId ?? '';
}

/** pathname → 当前 surface 的具体面包屑标题。 */
export function titleFromPath(pathname: string): string {
  return matchUiSurface(pathname)?.surface.title ?? '未知页面';
}

/**
 * 仅 inventory 明确允许的后台动态详情显示参数。学习者题目/KC/笔记/事件 id 不进入
 * 全局面包屑；静态 admin 页面已有自己的具体 title，也不再显示英文路径段。
 */
export function breadcrumbParamFromPath(pathname: string): string | null {
  const match = matchUiSurface(pathname);
  if (!match || !('showParam' in match.surface) || !match.surface.showParam) return null;
  return Object.values(match.params)[0] ?? null;
}

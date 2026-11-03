// YUK-329 — shell navigation projection.
//
// 页面路径、标题、active 归属、nav/search 可见性来自 kernel 的 UI_SURFACES；本文件只保留
// 图标（lucide）这种纯视觉映射与 section flattening，避免再造一份路由表。

import {
  ArrowRight,
  BookOpen,
  CircleAlert,
  Eye,
  GraduationCap,
  Hash,
  Home,
  Inbox,
  Layers,
  LibraryBig,
  type LucideIcon,
  Network,
  NotebookText,
  RotateCcw,
  Settings,
  Sparkles,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { UI_SURFACES, matchUiSurface } from '@/kernel/ui-surfaces';

/** 单条侧栏 nav 项。 */
export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
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

const SURFACE_ICONS: Record<string, LucideIcon> = {
  today: Home,
  practice: BookOpen,
  record: Upload,
  inbox: Inbox,
  mistakes: TriangleAlert,
  questions: LibraryBig,
  drafts: RotateCcw,
  knowledge: Network,
  notes: NotebookText,
  'agent-notes': Eye,
  coach: GraduationCap,
  'admin-config': Settings,
  'admin-runs': Settings,
  'admin-cost': Hash,
  'admin-failures': CircleAlert,
  'admin-subjects': Network,
  'admin-coverage-lattice': Layers,
  'admin-conjecture-scores': Sparkles,
};

function iconFor(id: string): LucideIcon {
  return SURFACE_ICONS[id] ?? ArrowRight;
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

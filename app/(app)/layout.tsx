'use client';

import { TokenGate } from '@/ui/components/TokenGate';
import { TabBar, type TabItem } from '@/ui/primitives/TabBar';
import { type NavItem, TopNav } from '@/ui/primitives/TopNav';
import { usePathname, useRouter } from 'next/navigation';

const NAV_ITEMS: NavItem[] = [
  { id: 'today', label: '今日' },
  { id: 'record', label: '录入' },
  { id: 'review', label: '复习' },
  { id: 'mistakes', label: '错题' },
  { id: 'items', label: '学习项' },
  { id: 'log', label: '日志' },
  { id: 'knowledge', label: '知识' },
];

// Mobile drops /learning-items + /study-log per plan Step 0 (≤5 tabs comfortable at thumb reach).
const MOBILE_TAB_ITEMS: TabItem[] = [
  { id: 'today', label: '今日' },
  { id: 'record', label: '录入' },
  { id: 'review', label: '复习' },
  { id: 'mistakes', label: '错题' },
  { id: 'knowledge', label: '知识' },
];

const ROUTE_MAP: Record<string, string> = {
  today: '/today',
  record: '/record',
  review: '/review',
  mistakes: '/mistakes',
  items: '/learning-items',
  log: '/study-log',
  knowledge: '/knowledge',
};

function activeFromPath(path: string): string {
  // Order matters: /learning-items before /knowledge etc.
  if (path.startsWith('/learning-items')) return 'items';
  if (path.startsWith('/study-log')) return 'log';
  if (path.startsWith('/today')) return 'today';
  if (path.startsWith('/record')) return 'record';
  if (path.startsWith('/review')) return 'review';
  if (path.startsWith('/mistakes')) return 'mistakes';
  if (path.startsWith('/knowledge')) return 'knowledge';
  return '';
}

export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeFromPath(pathname);

  const handleNav = (id: string) => {
    const target = ROUTE_MAP[id];
    if (target) router.push(target);
  };

  return (
    <TokenGate>
      <div className="app-shell">
        <div className="app-shell-top-nav">
          <TopNav active={active} onNav={handleNav} items={NAV_ITEMS} version="v0.1 · 1c.2" />
        </div>

        <div className="app-shell-content">{children}</div>

        <nav className="app-shell-bottom-tabs" aria-label="主导航">
          <TabBar items={MOBILE_TAB_ITEMS} active={active} onSelect={handleNav} />
        </nav>
      </div>
    </TokenGate>
  );
}

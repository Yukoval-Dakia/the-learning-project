'use client';

// AppTopbar — the loom sticky topbar. Ported from the <header className="topbar">
// block of docs/design/loom-prototype/app.jsx: mobile menu button, rail-collapse
// toggle, `Loom / TITLE / param` breadcrumbs, spacer, a VISUAL-ONLY ⌘K search
// box, and the Copilot IconBtn. Breadcrumb title/param derive from usePathname()
// via activeFromPath / paramFromPath (the prototype's parseRoute equivalent).
//
// .topbar / .crumbs / .searchbox / .menu-btn / .icon-btn live in app/globals.css.

import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { usePathname } from 'next/navigation';
import { TITLES, activeFromPath, paramFromPath } from './nav-config';

export interface AppTopbarProps {
  /** Open the mobile sidebar drawer. */
  onOpenMobileNav: () => void;
  /** Toggle the desktop rail collapse. */
  onToggleRail: () => void;
  /** Whether the rail is currently collapsed (drives toggle affordance). */
  railCollapsed: boolean;
  /** Open the Copilot drawer. */
  onOpenCopilot: () => void;
}

export function AppTopbar({
  onOpenMobileNav,
  onToggleRail,
  railCollapsed,
  onOpenCopilot,
}: AppTopbarProps) {
  const pathname = usePathname();
  const active = activeFromPath(pathname);
  const title = TITLES[active] || active || '今日';
  const param = paramFromPath(pathname);

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn menu-btn"
        onClick={onOpenMobileNav}
        aria-label="打开导航"
      >
        <LoomIcon name="menu" size={18} />
      </button>
      <IconBtn
        icon="panelLeft"
        size={16}
        className="rail-toggle"
        title={railCollapsed ? '展开侧栏' : '折叠侧栏'}
        aria-label={railCollapsed ? '展开侧栏' : '折叠侧栏'}
        aria-pressed={railCollapsed}
        onClick={onToggleRail}
        style={railCollapsed ? { color: 'var(--coral)' } : undefined}
      />
      <div className="crumbs">
        <span>Loom</span>
        <span className="sep">/</span>
        <b>{title}</b>
        {param != null && (
          <>
            <span className="sep">/</span>
            <b className="mono">{param}</b>
          </>
        )}
      </div>
      <div className="topbar-spacer" />
      <div className="searchbox" aria-hidden="true">
        <LoomIcon name="search" size={15} />
        <span>搜索卡片、节点、错题…</span>
        <kbd>⌘K</kbd>
      </div>
      <IconBtn
        icon="copilot"
        size={18}
        title="Copilot"
        aria-label="Copilot"
        onClick={onOpenCopilot}
      />
    </header>
  );
}

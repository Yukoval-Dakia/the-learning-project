'use client';

// AppSidebar — the loom sidebar-primary rail. Ported from the <aside
// className="sidebar"> block of docs/design/loom-prototype/app.jsx: BrandMark
// header, grouped .nav (LoomIcon + label + optional count badge), and the
// .sidebar-foot (Copilot / Admin / profile-mini + theme IconBtn). Active state
// comes from usePathname() via activeFromPath; navigation is router.push.
//
// The .sidebar / .nav / .nav-item / .sidebar-foot / .profile-mini classes are
// already defined in app/globals.css (loom @theme port). This component is
// purely structural over those classes.

import { BrandMark } from '@/ui/primitives/BrandMark';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useRef } from 'react';
import { NAV, ROUTE_MAP, activeFromPath, isSection } from './nav-config';

export interface AppSidebarProps {
  /** Whether the sidebar drawer is open on mobile (adds `.open`). */
  mobileOpen: boolean;
  /** Open the Copilot drawer (wired by the layout to CopilotDock). */
  onOpenCopilot: () => void;
  /** Current theme pref ('light' | 'dark'); drives the sun/moon icon. */
  theme: 'light' | 'dark';
  /** Toggle the theme (persists to localStorage 'loom-theme'). */
  onToggleTheme: () => void;
  /** Called after any nav action so the layout can close the mobile drawer. */
  onNavigated?: () => void;
}

export function AppSidebar({
  mobileOpen,
  onOpenCopilot,
  theme,
  onToggleTheme,
  onNavigated,
}: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeFromPath(pathname);

  // When open as a mobile drawer, trap focus inside the rail + Esc-to-close
  // (a11y). Inert on desktop where the sidebar is a permanent rail (mobileOpen
  // stays false). Esc closes via the same handler the scrim / nav clicks use.
  const sidebarRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => onNavigated?.(), [onNavigated]);
  useFocusTrap(mobileOpen, close, sidebarRef);

  const go = (path: string) => {
    router.push(path);
    onNavigated?.();
  };

  const themeIcon: LoomIconName = theme === 'light' ? 'moon' : 'sun';

  return (
    <aside ref={sidebarRef} className={`sidebar${mobileOpen ? ' open' : ''}`}>
      {/* /today 已迁 SPA（M4, YUK-319），Next 侧无此路由——brand 与 nav 同语义
          回退 /mistakes（coderabbit 验证轮指摘：原 go('/today') 是死链）。 */}
      <button type="button" className="brand" onClick={() => go('/mistakes')}>
        <span className="brand-mark">
          <BrandMark size={32} />
        </span>
        <span>
          <div className="brand-name">Loom</div>
          <div className="brand-sub">织 · 学习编织台</div>
        </span>
      </button>

      <nav className="nav">
        {NAV.map((entry) =>
          isSection(entry) ? (
            <div key={`section-${entry.section}`} className="nav-section-label">
              {entry.section}
            </div>
          ) : (
            <button
              key={entry.id}
              type="button"
              className={`nav-item${active === entry.id ? ' is-active' : ''}`}
              // fallback /mistakes：/today 已迁 SPA，Next 侧无此路由（M4, YUK-319）
              onClick={() => go(ROUTE_MAP[entry.id] ?? '/mistakes')}
              title={entry.label}
            >
              <LoomIcon name={entry.icon} size={19} />
              <span className="nav-label">{entry.label}</span>
              {entry.count != null && <span className="nav-count tnum">{entry.count}</span>}
            </button>
          ),
        )}
      </nav>

      <div className="sidebar-foot">
        <button type="button" className="nav-item sidebar-foot-full" onClick={onOpenCopilot}>
          <LoomIcon name="copilot" size={19} />
          <span className="nav-label">Copilot</span>
        </button>
        <button
          type="button"
          className="nav-item sidebar-foot-full"
          onClick={() => go('/admin/runs')}
          title="Admin"
        >
          <LoomIcon name="settings" size={19} />
          <span className="nav-label">Admin</span>
        </button>
        <div className="sidebar-foot-row">
          <button type="button" className="profile-mini">
            <span className="avatar">知</span>
            <span className="sidebar-foot-full" style={{ minWidth: 0 }}>
              <div className="pm-name">知微</div>
              <div className="pm-sub">Studio</div>
            </span>
          </button>
          <IconBtn
            icon={themeIcon}
            size={16}
            title="切换主题"
            aria-label="切换主题"
            onClick={onToggleTheme}
          />
        </div>
      </div>
    </aside>
  );
}

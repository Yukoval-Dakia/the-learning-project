// S13 (YUK-335 批次丙) — SPA 侧栏 rail（sidebar-primary 设计的主导航）。
//
// 设计源 docs/design/loom-refresh/project/app.jsx 的 <aside className="sidebar">
// 块：BrandMark 头 + 分组 .nav（LoomIcon + label + 可选 count badge）+
// .sidebar-foot（Copilot / Admin / profile-mini + 主题 IconBtn）。
//
// 路由耦合只经 prop（navigate / pathname）—— 不 import 任何路由库（区别于 M5
// 拆除的旧壳版本，那版 import next/navigation；SPA 是 TanStack Router）。is-active
// 由 pathname 经 activeFromPath 派生。
//
// .sidebar / .brand / .nav / .nav-item / .nav-count / .sidebar-foot /
// .profile-mini / .avatar 等类已在 web/src/globals.css（loom 端口，§App shell
// L5705-5927）就位 —— 本组件纯结构覆盖这些类，不重定义 CSS。

import { BrandMark } from '@/ui/primitives/BrandMark';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { useCallback, useRef } from 'react';
import { NAV, activeFromPath, isSection } from './nav-config';

export interface AppSidebarProps {
  /** 当前路由 pathname（RootShell 经 useRouterState 注入）；驱动 is-active。 */
  pathname: string;
  /** 路由推入（RootShell 经 router.history.push 注入）。 */
  navigate: (to: string) => void;
  /** 移动端 drawer 是否打开（加 `.open`）。 */
  mobileOpen: boolean;
  /** 打开 Copilot dock（RootShell 接到 CopilotDock 的隐藏 trigger）。 */
  onOpenCopilot: () => void;
  /** 当前主题（'light' | 'dark'）；驱动 sun/moon 图标。 */
  theme: 'light' | 'dark';
  /** 切换主题（RootShell 持有 state + 持久化 localStorage 'loom-theme'）。 */
  onToggleTheme: () => void;
  /** 任一 nav 动作后回调，让 RootShell 关闭移动 drawer。 */
  onNavigated?: () => void;
  /** 收件箱待审提议数（workbench summary proposals.total）；>0 才渲 count badge。 */
  inboxCount?: number;
}

export function AppSidebar({
  pathname,
  navigate,
  mobileOpen,
  onOpenCopilot,
  theme,
  onToggleTheme,
  onNavigated,
  inboxCount,
}: AppSidebarProps) {
  const active = activeFromPath(pathname);

  // 作为移动 drawer 打开时，trap focus 在 rail 内 + Esc 关闭（a11y）。桌面端是
  // 常驻 rail（mobileOpen 恒 false）时 inert。Esc 经与 scrim / nav 点击同一 close
  // 路径关闭。
  const sidebarRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => onNavigated?.(), [onNavigated]);
  useFocusTrap(mobileOpen, close, sidebarRef);

  const go = (path: string) => {
    navigate(path);
    onNavigated?.();
  };

  const themeIcon: LoomIconName = theme === 'light' ? 'moon' : 'sun';

  return (
    <aside ref={sidebarRef} className={`sidebar${mobileOpen ? ' open' : ''}`}>
      {/* brand 点击 → /today（SPA 默认面；区别于 M5 拆除旧壳回退 /mistakes）。 */}
      <button type="button" className="brand" onClick={() => go('/today')}>
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
              onClick={() => go(entry.path)}
              title={entry.label}
            >
              <LoomIcon name={entry.icon} size={19} />
              <span className="nav-label">{entry.label}</span>
              {/* count 仅 inbox 接真值（proposals.total）；>0 才渲，无真源不 fabricate。 */}
              {entry.id === 'inbox' && inboxCount != null && inboxCount > 0 ? (
                <span className="nav-count tnum">{inboxCount}</span>
              ) : null}
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

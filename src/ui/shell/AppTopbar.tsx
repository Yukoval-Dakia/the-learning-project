// S13 (YUK-335 批次丙) — SPA sticky topbar。
//
// 设计源 docs/design/loom-refresh/project/app.jsx 的 <header className="topbar">
// 块：移动 menu 按钮、桌面 rail 折叠 toggle、`Loom / TITLE / param` 面包屑、
// spacer、⌘K searchbox、Copilot IconBtn。面包屑 title/param 由 pathname 经
// titleFromPath / breadcrumbParamFromPath 派生（设计 parseRoute 等价物）。
//
// 路由耦合只经 prop（pathname）—— 不 import 路由库。.topbar / .crumbs /
// .searchbox / .menu-btn / .icon-btn / .rail-toggle / .topbar-spacer 均在
// web/src/globals.css（§App shell L5954-6041）就位。

import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { COMMAND_PALETTE_PLACEHOLDER, breadcrumbParamFromPath, titleFromPath } from './nav-config';

export interface AppTopbarProps {
  /** 当前路由 pathname（RootShell 经 useRouterState 注入）；驱动面包屑。 */
  pathname: string;
  /** 打开移动侧栏 drawer。 */
  onOpenMobileNav: () => void;
  /** 切换桌面 rail 折叠。 */
  onToggleRail: () => void;
  /** rail 当前是否折叠（驱动 toggle 视觉 affordance）。 */
  railCollapsed: boolean;
  /** 打开命令面板（searchbox 点击 / ⌘K）。S14 接 CommandPalette；本 slice 只
      把它接到 RootShell 的 paletteOpen setter。 */
  onOpenPalette: () => void;
  /** 打开 Copilot dock。 */
  onOpenCopilot: () => void;
  /** 待查看的主动提示数；显示在真正可见的 Copilot launcher 上。 */
  copilotNudgeCount?: number;
}

export function AppTopbar({
  pathname,
  onOpenMobileNav,
  onToggleRail,
  railCollapsed,
  onOpenPalette,
  onOpenCopilot,
  copilotNudgeCount = 0,
}: AppTopbarProps) {
  const title = titleFromPath(pathname);
  const param = breadcrumbParamFromPath(pathname);

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
      {/* searchbox 是真入口（区别于 M5 旧壳的 aria-hidden 假占位）：点击 / ⌘K
          开命令面板。S14 建 CommandPalette 后接 RootShell paletteOpen。 */}
      <button type="button" className="searchbox" onClick={onOpenPalette} aria-label="搜索（⌘K）">
        <LoomIcon name="search" size={15} />
        <span>{COMMAND_PALETTE_PLACEHOLDER}</span>
        <kbd>⌘K</kbd>
      </button>
      <span className="relative inline-flex">
        <IconBtn
          icon="copilot"
          size={18}
          title="Copilot"
          aria-label={
            copilotNudgeCount > 0 ? `Copilot，${copilotNudgeCount} 条主动提示` : 'Copilot'
          }
          onClick={onOpenCopilot}
        />
        {copilotNudgeCount > 0 ? (
          <span
            className="pointer-events-none absolute -top-[4px] -right-[4px] flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[var(--ink-2)] px-[4px] text-[10px] font-medium leading-none text-[var(--surface,#fff)]"
            data-testid="copilot-nudge-launcher-badge"
            aria-hidden="true"
          >
            {copilotNudgeCount}
          </span>
        ) : null}
      </span>
    </header>
  );
}

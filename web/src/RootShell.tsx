import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { CopilotDock } from '@/capabilities/copilot/ui-public';
import { useWorkbenchClient } from '@/capabilities/shell/ui-public';
import { AppSidebar } from '@/ui/shell/AppSidebar';
import { AppTopbar } from '@/ui/shell/AppTopbar';
import { CommandPalette } from '@/ui/shell/CommandPalette';
import { MobileTabBar } from '@/ui/shell/MobileTabBar';
import { ShellMain } from '@/ui/shell/ShellMain';

// S13 (YUK-335 批次丙) — 主题持久化 key，与 design app.jsx:86 / 既有
// ThemeToggle primitive 同 key（'loom-theme'），互不打架。
const THEME_KEY = 'loom-theme';

function readSavedTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  try {
    return window.localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

// M5-T3 (YUK-321) — 根壳：全路由共享一个 CopilotDock 实例（裁决 c：组件归
// copilot 包，路由耦合只存在于本壳层）。
//
// S13 (YUK-335 批次丙) — chrome 收编为设计的 sidebar-primary 五件套：
// .app > AppSidebar + (.main > AppTopbar + <Outlet/>) + MobileTabBar + 根挂
// CopilotDock。RootShell 持 paletteOpen（S14 已接 CommandPalette）/ mobileNavOpen /
// railCollapsed / theme state。admin 路由照常套主 chrome（owner override 设计
// app.jsx:106「admin separate shell」——见 docs/audit/2026-06-13-visual-gap.md）。
export function RootShell({
  children,
  pathname,
  navigate,
}: {
  children: ReactNode;
  pathname: string;
  navigate: (to: string) => void;
}) {
  // chrome state。paletteOpen 驱动 CommandPalette（S14）；⌘K toggle + searchbox
  // 点击都 set 它。
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [copilotNudgeCount, setCopilotNudgeCount] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches === true,
  );
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // 主题：mount 时从 localStorage 读，应用到 <html data-theme>（SPA 此前无任何
  // data-theme 设值，此为首处）；toggle 时持久化（设计 app.jsx:86 做法）。
  useEffect(() => {
    setTheme(readSavedTheme());
  }, []);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 720px)');
    const sync = () => setMobileLayout(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  useEffect(() => {
    if (!mobileLayout) setMobileNavOpen(false);
  }, [mobileLayout]);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // localStorage 不可用（隐私模式等）时静默——主题仍在本会话内生效。
    }
  }, [theme]);

  // ⌘K toggle 命令面板（CommandPalette, S14）。与 design app.jsx:90 同 keybind。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 收件箱待办 count：复用 workbench summary proposals.decision_total（与 TodayPage 同 query
  // key ['workbench-summary'] → React Query 去重，不增请求）。无数据时 undefined
  // → 侧栏不渲 count（不 fabricate 假数字）。
  const { getWorkbenchSummary } = useWorkbenchClient();
  const summaryQ = useQuery({ queryKey: ['workbench-summary'], queryFn: getWorkbenchSummary });
  const inboxCount = summaryQ.data?.proposals.decision_total;
  const inboxCountUncertain = summaryQ.data?.proposals.has_more === true;

  // Copilot 开启：CopilotDock 自带的 in-flow launcher wrapper 经
  // .shell-copilot-mount CSS 隐藏；侧栏 / topbar 的正式按钮以编程方式点击其内部
  // trigger（data-testid=copilot-drawer-trigger）走既有 dock-open 路径，不造新机制。
  const copilotMountRef = useRef<HTMLDivElement | null>(null);
  const openCopilot = useCallback(() => {
    copilotMountRef.current
      ?.querySelector<HTMLButtonElement>('[data-testid="copilot-drawer-trigger"]')
      ?.click();
  }, []);

  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  return (
    // data-palette-open 反映 paletteOpen state（CSS 钩子）；CommandPalette（S14，
    // 见本组件尾部根挂）直接消费 paletteOpen state 控制开合。
    <div
      className={`app${railCollapsed ? ' rail-collapsed' : ''}`}
      data-palette-open={paletteOpen ? '' : undefined}
      // F7 (Codex #401)：移动 nav 抽屉打开时隐藏底部 tabbar——否则 tabbar（fixed
      // z-index:40）画在 scrim（z-index:25）/ 抽屉之上仍可点，用户能在 focus trap
      // 仍开时触发导航。CSS 钩子（≤720px 生效；同 data-palette-open 用 undefined 关闭）。
      data-mobile-nav-open={mobileNavOpen ? '' : undefined}
    >
      {mobileNavOpen && (
        // 移动 nav scrim：点击关闭。用 <button>（键盘可达，沿 CopilotDrawer scrim
        // 先例），避免 div+onClick 的 a11y 漏洞；border/padding 归零让 .scrim 视觉
        // 不受 button 默认 chrome 影响。
        <button
          type="button"
          aria-label="关闭导航"
          className="scrim open"
          style={{ zIndex: 25, border: 0, padding: 0 }}
          onClick={closeMobileNav}
        />
      )}

      <AppSidebar
        pathname={pathname}
        navigate={navigate}
        mobileOpen={mobileNavOpen}
        mobileLayout={mobileLayout}
        onOpenCopilot={openCopilot}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        onNavigated={closeMobileNav}
        inboxCount={inboxCount}
        inboxCountUncertain={inboxCountUncertain}
      />

      <ShellMain blockedByModal={mobileNavOpen}>
        <AppTopbar
          pathname={pathname}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onToggleRail={() => setRailCollapsed((c) => !c)}
          railCollapsed={railCollapsed}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenCopilot={openCopilot}
          copilotNudgeCount={copilotNudgeCount}
        />
        {children}
      </ShellMain>

      <MobileTabBar
        pathname={pathname}
        navigate={navigate}
        onOpenMobileNav={() => setMobileNavOpen(true)}
      />

      {/* CopilotDock 根挂（保留既有实例 + explicit-open + navigate/pathname 接线）。
          .shell-copilot-mount 隐藏其 launcher wrapper；drawer 本身 fixed 渲到根。
          nudge 数量上提给 AppTopbar 的可见 launcher，避免重复入口。 */}
      <div ref={copilotMountRef} className="shell-copilot-mount">
        <CopilotDock
          pathname={pathname}
          navigate={navigate}
          onNudgeCountChange={setCopilotNudgeCount}
        />
      </div>

      {/* S14/YUK-329 — ⌘K 命令面板消费 paletteOpen seam。组件 fixed 渲到根；
          页面组投影 shipped surface inventory，知识节点走 /api/knowledge fetch。 */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        navigate={navigate}
      />
    </div>
  );
}

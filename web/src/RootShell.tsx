import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useRef, useState, useSyncExternalStore } from 'react';
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
const THEME_ATTR = 'data-theme';
type ShellTheme = 'light' | 'dark';

function readSavedTheme(): ShellTheme {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

// YUK-1483 — 主题的真相是 <html data-theme>（RootShell 是它唯一的全局 owner）。
// 读快照只读 DOM；改动经 MutationObserver 通知，所以壳 attach 时应用已存主题、
// 用户切换命令都会让 sidebar 图标同步。SSR / hydration 快照固定 light。
function readAppliedTheme(): ShellTheme {
  return document.documentElement.getAttribute(THEME_ATTR) === 'dark' ? 'dark' : 'light';
}

function readServerTheme(): ShellTheme {
  return 'light';
}

function subscribeTheme(notify: () => void): () => void {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTR] });
  return () => observer.disconnect();
}

function applyTheme(theme: ShellTheme): void {
  document.documentElement.setAttribute(THEME_ATTR, theme);
}

function persistTheme(theme: ShellTheme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // localStorage 不可用（隐私模式等）时静默——主题仍在本会话内生效。
  }
}

// ≤720px 走手机布局（抽屉导航 + 底部 tabbar）。SSR 快照固定桌面。
const MOBILE_QUERY = '(max-width: 720px)';

function readMobileLayout(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches;
}

function readServerMobileLayout(): boolean {
  return false;
}

// 与 copilot useCopilotNudges 的 query key 相同。RootShell 只挂一个不取数的观察者读
// 现有缓存快照：轮询（60s）与 dismiss/opened 失效仍由 CopilotDock 的那个 query 负责，
// 这里不另起第二个轮询。
const COPILOT_NUDGES_KEY = ['copilot', 'nudges'] as const;

// YUK-1528 — 印刷页（/print/…）由渲染任务直接出 PDF：不要侧栏、Copilot、topbar，
// 也不发壳层自己的请求（workbench summary 等），所以在挂任何壳层 hook 之前就分流。
const BARE_PATH_PREFIX = '/print/';

export function RootShell(props: {
  children: ReactNode;
  pathname: string;
  navigate: (to: string) => void;
}) {
  if (props.pathname.startsWith(BARE_PATH_PREFIX)) return <>{props.children}</>;
  return <AppFrame {...props} />;
}

// M5-T3 (YUK-321) — 根壳：全路由共享一个 CopilotDock 实例（裁决 c：组件归
// copilot 包，路由耦合只存在于本壳层）。
//
// S13 (YUK-335 批次丙) — chrome 收编为设计的 sidebar-primary 五件套：
// .app > AppSidebar + (.main > AppTopbar + <Outlet/>) + MobileTabBar + 根挂
// CopilotDock。RootShell 持 paletteOpen（S14 已接 CommandPalette）/ mobileNavOpen /
// railCollapsed / theme state。admin 路由照常套主 chrome（owner override 设计
// app.jsx:106「admin separate shell」——见 docs/audit/2026-06-13-visual-gap.md）。
function AppFrame({
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);

  const theme = useSyncExternalStore(subscribeTheme, readAppliedTheme, readServerTheme);
  const toggleTheme = () => {
    const next: ShellTheme = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    persistTheme(next);
  };

  // 720px 断点订阅。离开手机布局时关掉手机导航（change 事件里清），回到手机不复活；
  // 渲染时也只在手机布局下认 mobileNavOpen。
  const subscribeMobileLayout = useCallback((notify: () => void) => {
    if (typeof window.matchMedia !== 'function') return () => {};
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = () => {
      if (!media.matches) setMobileNavOpen(false);
      notify();
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  const mobileLayout = useSyncExternalStore(
    subscribeMobileLayout,
    readMobileLayout,
    readServerMobileLayout,
  );
  const navOpen = mobileLayout && mobileNavOpen;

  // 壳根节点 attach：应用已存主题到 <html data-theme>（SPA 与 Start 共用本壳），并挂
  // 唯一一个 ⌘K 全局快捷键（与 design app.jsx:90 同 keybind）；卸载时移除。
  const attachShell = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    applyTheme(readSavedTheme());
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Copilot nudge 角标：读现有 nudges query 的缓存快照（见 COPILOT_NUDGES_KEY）。
  const nudgeCountQ = useQuery<{ nudges: unknown[] }, Error, number>({
    queryKey: COPILOT_NUDGES_KEY,
    enabled: false,
    select: (data) => data.nudges.length,
  });
  const copilotNudgeCount = nudgeCountQ.data ?? 0;

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
      ref={attachShell}
      className={`app${railCollapsed ? ' rail-collapsed' : ''}`}
      data-palette-open={paletteOpen ? '' : undefined}
      // F7 (Codex #401)：移动 nav 抽屉打开时隐藏底部 tabbar——否则 tabbar（fixed
      // z-index:40）画在 scrim（z-index:25）/ 抽屉之上仍可点，用户能在 focus trap
      // 仍开时触发导航。CSS 钩子（≤720px 生效；同 data-palette-open 用 undefined 关闭）。
      data-mobile-nav-open={navOpen ? '' : undefined}
    >
      {navOpen && (
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
        mobileOpen={navOpen}
        mobileLayout={mobileLayout}
        onOpenCopilot={openCopilot}
        theme={theme}
        onToggleTheme={toggleTheme}
        onNavigated={closeMobileNav}
        inboxCount={inboxCount}
        inboxCountUncertain={inboxCountUncertain}
      />

      <ShellMain blockedByModal={navOpen}>
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
          nudge 数量由本壳从 nudges query 快照读给 AppTopbar 的可见 launcher。 */}
      <div ref={copilotMountRef} className="shell-copilot-mount">
        <CopilotDock pathname={pathname} navigate={navigate} />
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

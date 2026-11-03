import { notifyManager, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { type CompanionLayout, CompanionMount } from '@/capabilities/copilot/ui-public';
import type { NotePageClient } from '@/capabilities/notes/ui-public';
import {
  ConfirmationAssessment,
  type ConfirmationDraftClient,
} from '@/capabilities/practice/ui-public';
import { useWorkbenchClient } from '@/capabilities/shell/ui-public';
import { queryKeys } from '@/ui/lib/write-invalidation';
import { StudioNavigation } from '@/ui-next/practice-studio/StudioShell';
import { CommandPalette, type CommandPaletteProps } from './CommandPalette';
import { NAV, type NavItem, activeFromPath, isSection } from './nav-config';

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

// 学习伙伴的三种形态（ux-shell-today.md）：手机 ≤720 全高底部面板；iPad 721–1199 浮在页面上；
// 桌面 ≥1200 内容右侧一栏。
const COMPANION_FLOAT_QUERY = '(max-width: 1199px)';

function readCompanionLayout(): CompanionLayout {
  if (typeof window.matchMedia !== 'function') return 'side';
  if (window.matchMedia(MOBILE_QUERY).matches) return 'sheet';
  return window.matchMedia(COMPANION_FLOAT_QUERY).matches ? 'float' : 'side';
}

function readServerCompanionLayout(): CompanionLayout {
  return 'side';
}

function subscribeCompanionLayout(notify: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const queries = [window.matchMedia(MOBILE_QUERY), window.matchMedia(COMPANION_FLOAT_QUERY)];
  for (const query of queries) query.addEventListener('change', notify);
  return () => {
    for (const query of queries) query.removeEventListener('change', notify);
  };
}

// 与 copilot useCopilotNudges 的 query key 相同。RootShell 不挂 query 观察者，只订阅
// QueryCache 读这条缓存的条数（同 react-query 自己的 useIsFetching 写法）：轮询（60s）与
// dismiss/opened 失效仍由学习伙伴里的那个 query 负责，这里不发请求、不另起轮询，也就没有
// 「No queryFn was passed」的报错。
const COPILOT_NUDGES_KEY = ['copilot', 'nudges'] as const;

function readServerNudgeCount(): number {
  return 0;
}

interface ShellMainProps {
  blockedByModal: boolean;
  children: ReactNode;
}

/**
 * 主内容区的模态隔离边界。
 *
 * 移动导航打开时，视觉 scrim 之外还必须让页面退出读屏树与键盘顺序；关闭后
 * React 会同时移除两项属性，恢复原有交互。
 */
function ShellMain({ blockedByModal, children }: ShellMainProps) {
  return (
    <div className="main" aria-hidden={blockedByModal ? true : undefined} inert={blockedByModal}>
      {children}
    </div>
  );
}

// M5-T3 (YUK-321) — 根壳：全路由共享一个学习伙伴实例（裁决 c：组件归
// copilot 包，路由耦合只存在于本壳层）。
//
// RootShell owns navigation, theme and the single Companion lifetime; presenters only arrange them.
export function RootShell({
  confirmationClient,
  children,
  pathname,
  navigate,
  readKnowledgeTree,
  readNotePage,
}: {
  confirmationClient?: ConfirmationDraftClient;
  children: ReactNode;
  pathname: string;
  navigate: (to: string) => void;
  readKnowledgeTree?: CommandPaletteProps['readTree'];
  readNotePage: NotePageClient;
}) {
  // chrome state。paletteOpen 驱动 CommandPalette（S14）；⌘K toggle + searchbox
  // 点击都 set 它。
  const ConfirmationRenderer = useMemo(
    () =>
      function ConfirmationRenderer(props: ComponentProps<typeof ConfirmationAssessment>) {
        return <ConfirmationAssessment {...props} client={confirmationClient} />;
      },
    [confirmationClient],
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [companionOpen, setCompanionOpen] = useState(false);
  const companionLayout = useSyncExternalStore(
    subscribeCompanionLayout,
    readCompanionLayout,
    readServerCompanionLayout,
  );

  const theme = useSyncExternalStore(subscribeTheme, readAppliedTheme, readServerTheme);
  const toggleTheme = () => {
    const next: ShellTheme = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    persistTheme(next);
  };

  const navOpen = mobileNavOpen;

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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setCompanionOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Copilot nudge 角标：读现有 nudges query 的缓存条数（见 COPILOT_NUDGES_KEY）。
  const queryClient = useQueryClient();
  const subscribeNudges = useCallback(
    (notify: () => void) => queryClient.getQueryCache().subscribe(notifyManager.batchCalls(notify)),
    [queryClient],
  );
  const readNudgeCount = useCallback(
    () => queryClient.getQueryData<{ nudges: unknown[] }>(COPILOT_NUDGES_KEY)?.nudges.length ?? 0,
    [queryClient],
  );
  const copilotNudgeCount = useSyncExternalStore(
    subscribeNudges,
    readNudgeCount,
    readServerNudgeCount,
  );

  // 收件箱待办 count：复用 workbench summary proposals.decision_total（与 TodayPage 同 query
  // key ['workbench-summary'] → React Query 去重，不增请求）。无数据时 undefined
  // → 侧栏不渲 count（不 fabricate 假数字）。
  const { getWorkbenchSummary } = useWorkbenchClient();
  const summaryQ = useQuery({ queryKey: queryKeys.workbenchSummary, queryFn: getWorkbenchSummary });
  const inboxCount = summaryQ.data?.proposals.decision_total;
  const inboxCountUncertain = summaryQ.data?.proposals.has_more === true;

  const companionSide = companionLayout === 'side' && companionOpen;
  // A medium viewport keeps one readable task pane; the same existing sheet owner handles focus and scroll.
  const presentationLayout = companionLayout === 'float' ? 'sheet' : companionLayout;
  const companionModal = companionOpen && presentationLayout === 'sheet';

  return (
    <div
      ref={attachShell}
      className="un-st un-st-shell"
      data-ui-next=""
      data-un-m3e="practice-studio"
      data-theme={theme}
      data-companion-side={companionSide || undefined}
      data-palette-open={paletteOpen ? '' : undefined}
      data-mobile-nav-open={navOpen ? '' : undefined}
    >
      <StudioNavigation
        items={NAV.filter((entry): entry is NavItem => !isSection(entry)).map((entry) => ({
          id: entry.id,
          label: entry.label,
          current: activeFromPath(pathname) === entry.id,
          onSelect: () => navigate(entry.path),
        }))}
        navigationOpen={navOpen}
        onNavigationOpen={setMobileNavOpen}
        blocked={companionModal}
        theme={theme}
        companionOpen={companionOpen}
        nudgeCount={copilotNudgeCount}
        inboxCount={inboxCount}
        inboxCountUncertain={inboxCountUncertain}
        onSearch={() => setPaletteOpen(true)}
        onTheme={toggleTheme}
        onCompanion={() => {
          setMobileNavOpen(false);
          setCompanionOpen((open) => !open);
        }}
      />
      <ShellMain blockedByModal={navOpen || companionModal}>{children}</ShellMain>
      <div className="un-st-companion-slot">
        <CompanionMount
          confirmationRenderer={ConfirmationRenderer}
          readNotePage={readNotePage}
          open={companionOpen}
          presentation="workspace"
          onOpenChange={setCompanionOpen}
          layout={presentationLayout}
          navigate={navigate}
        />
      </div>
      <CommandPalette
        readTree={readKnowledgeTree}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        navigate={navigate}
      />
    </div>
  );
}

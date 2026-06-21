// M0 (YUK-313) — SPA 路由表。规则（记入 ARCHITECTURE）：capability ui 不 import
// 路由库；导航以 (to: string) => void prop 注入——路由耦合只存在于本壳层。
// M0 仅 /agent-notes 一条 surface；后续 surface 随各 M 在此登记。
import AgentNotesPage from '@/capabilities/agency/ui/page';
import { CopilotDock } from '@/capabilities/copilot/ui/CopilotDock';
import RecordPage from '@/capabilities/ingestion/ui/RecordPage';
import KnowledgeDetailPage from '@/capabilities/knowledge/ui/KnowledgeDetailPage';
import KnowledgePage from '@/capabilities/knowledge/ui/KnowledgePage';
import NoteReaderPage from '@/capabilities/notes/ui/NoteReaderPage';
import {
  AdminCostSurface,
  AdminFailuresSurface,
  AdminRunsSurface,
} from '@/capabilities/observability/ui/observability';
import { AdminSubjectsSurface } from '@/capabilities/observability/ui/subjects';
import OnboardRecord from '@/capabilities/onboarding/ui/OnboardRecord';
import PlacementStubPage from '@/capabilities/onboarding/ui/PlacementStubPage';
import WelcomePage from '@/capabilities/onboarding/ui/WelcomePage';
import DraftReviewPage from '@/capabilities/practice/ui/DraftReviewPage';
import PracticeFacePage from '@/capabilities/practice/ui/PracticeFacePage';
import QuestionDetailPage from '@/capabilities/practice/ui/QuestionDetailPage';
import QuestionsPage from '@/capabilities/practice/ui/QuestionsPage';
import CoachPage from '@/capabilities/shell/ui/CoachPage';
import InboxPage from '@/capabilities/shell/ui/InboxPage';
import TodayPage from '@/capabilities/shell/ui/TodayPage';
import { getWorkbenchSummary } from '@/capabilities/shell/ui/workbench-api';
import { AppSidebar } from '@/ui/shell/AppSidebar';
import { AppTopbar } from '@/ui/shell/AppTopbar';
import { CommandPalette } from '@/ui/shell/CommandPalette';
import { MobileTabBar } from '@/ui/shell/MobileTabBar';
import { useQuery } from '@tanstack/react-query';
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import MistakesPage from './routes/MistakesPage';

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
function RootShell() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useCallback((to: string) => router.history.push(to), [router]);

  // chrome state。paletteOpen 驱动 CommandPalette（S14）；⌘K toggle + searchbox
  // 点击都 set 它。
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // 主题：mount 时从 localStorage 读，应用到 <html data-theme>（SPA 此前无任何
  // data-theme 设值，此为首处）；toggle 时持久化（设计 app.jsx:86 做法）。
  useEffect(() => {
    setTheme(readSavedTheme());
  }, []);
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

  // 收件箱 count：复用 workbench summary proposals.total（与 TodayPage 同 query
  // key ['workbench-summary'] → React Query 去重，不增请求）。无数据时 undefined
  // → 侧栏不渲 count（不 fabricate 假数字）。
  const summaryQ = useQuery({ queryKey: ['workbench-summary'], queryFn: getWorkbenchSummary });
  const inboxCount = summaryQ.data?.proposals.total;

  // Copilot 开启：CopilotDock 自带的 in-flow trigger（data-testid
  // copilot-drawer-trigger，调用其 dwell openDrawer）经 .shell-copilot-mount CSS
  // 隐藏（web/src/globals.css L5997-6000，原为本壳预留的 dead CSS）；侧栏 / topbar
  // 的 Copilot 按钮以编程方式点击该隐藏 trigger 走既有 dock-open 路径，不造新机制。
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
        onOpenCopilot={openCopilot}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        onNavigated={closeMobileNav}
        inboxCount={inboxCount}
      />

      <div className="main">
        <AppTopbar
          pathname={pathname}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onToggleRail={() => setRailCollapsed((c) => !c)}
          railCollapsed={railCollapsed}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenCopilot={openCopilot}
        />
        <Outlet />
      </div>

      <MobileTabBar
        pathname={pathname}
        navigate={navigate}
        onOpenMobileNav={() => setMobileNavOpen(true)}
      />

      {/* CopilotDock 根挂（保留既有实例 + dwell + navigate/pathname 接线）。
          .shell-copilot-mount 隐藏其 in-flow trigger；drawer 本身 fixed 渲到根。 */}
      <div ref={copilotMountRef} className="shell-copilot-mount">
        <CopilotDock pathname={pathname} navigate={navigate} />
      </div>

      {/* S14 (YUK-335) — ⌘K 命令面板，消费 S13 铺好的 paletteOpen seam（⌘K toggle
          + searchbox 点击都 set paletteOpen）。组件 fixed 渲到根（scrim 全屏）；
          页面组复用 nav-config，知识节点走 /api/knowledge fetch。 */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        navigate={navigate}
      />
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootShell });

// M4-T6 (YUK-319)：工作台上线后 / 落到 /today（旧 SPA 默认 /agent-notes 退位，
// 该页仍在路由表）。
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/today' });
  },
});

// M4-T6 (YUK-319/YUK-318) — 工作台 + 提议收件箱。
function TodayRoute() {
  const router = useRouter();
  return <TodayPage navigate={(to) => router.history.push(to)} />;
}

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/today',
  component: TodayRoute,
});

// YUK-473 cold-start onboarding flow. /welcome 是 /today 冷拦截（goal_count===0）
// 的 CTA 落点（设定 ①）。Slice 2：/onboarding/upload 已是真 OnboardRecord（②a 上传→
// OCR→auto-enroll 尾巴入池→/placement）；/placement 仍是 stub（下一片替换为真定位）。
// 导航走壳层 prop 注入（同 TodayRoute）。
function WelcomeRoute() {
  const router = useRouter();
  return <WelcomePage navigate={(to) => router.history.push(to)} />;
}

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/welcome',
  component: WelcomeRoute,
});

function OnboardingUploadRoute() {
  const router = useRouter();
  return <OnboardRecord navigate={(to) => router.history.push(to)} />;
}

const onboardingUploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding/upload',
  component: OnboardingUploadRoute,
});

function PlacementRoute() {
  const router = useRouter();
  return <PlacementStubPage navigate={(to) => router.history.push(to)} />;
}

const placementRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/placement',
  component: PlacementRoute,
});

function InboxRoute() {
  const router = useRouter();
  return <InboxPage navigate={(to) => router.history.push(to)} />;
}

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxRoute,
});

// Usability Step1 (YUK-354) — 错题本面（loom screen-mistakes ScreenMistakes）。闭合
// record→see→practice 死链：RecordPage onSuccess navigate('/mistakes') 此前 404。导航走
// 壳层 prop 注入（同 InboxRoute），page 自持 list query + 客户端 3 轴筛选（科目/状态/归因）。
function MistakesRoute() {
  const router = useRouter();
  return <MistakesPage navigate={(to) => router.history.push(to)} />;
}

const mistakesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mistakes',
  component: MistakesRoute,
});

function AgentNotesRoute() {
  const router = useRouter();
  // history.push 绕开 TanStack 的字面量路由类型——agent-notes 卡片的证据链接
  // 指向 /events、/knowledge/* 等尚未在 SPA 登记的 surface（M3/M4 落地前 404 属预期）。
  return <AgentNotesPage navigate={(to) => router.history.push(to)} />;
}

const agentNotesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agent-notes',
  component: AgentNotesRoute,
});

// M1-T6 (YUK-314) — 录入面。query 读写直接走 window.location + history.replace：
// getQuery 只在 VisionTab 的 mount-only 恢复 effect 里读一次（不需要 reactive
// 订阅）；setQuery 是 replace 语义（?ingest= 进行中会话的持久化/清除）。
function RecordRoute() {
  const router = useRouter();
  return (
    <RecordPage
      navigate={(to) => router.history.push(to)}
      getQuery={(key) => new URLSearchParams(window.location.search).get(key)}
      setQuery={(key, value) => {
        const sp = new URLSearchParams(window.location.search);
        if (value === null) sp.delete(key);
        else sp.set(key, value);
        router.history.replace(
          `${window.location.pathname}${sp.toString() ? `?${sp.toString()}` : ''}`,
        );
      }}
    />
  );
}

const recordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/record',
  component: RecordRoute,
});

// M2-T6 (YUK-316) — 练习面。query 协议同 RecordRoute：?view=shelf 切卷架，
// setQuery 是 replace 语义（视图切换不进 history 栈）。
function PracticeRoute() {
  const router = useRouter();
  return (
    <PracticeFacePage
      navigate={(to) => router.history.push(to)}
      getQuery={(key) => new URLSearchParams(window.location.search).get(key)}
      setQuery={(key, value) => {
        const sp = new URLSearchParams(window.location.search);
        if (value === null) sp.delete(key);
        else sp.set(key, value);
        router.history.replace(
          `${window.location.pathname}${sp.toString() ? `?${sp.toString()}` : ''}`,
        );
      }}
    />
  );
}

const practiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/practice',
  component: PracticeRoute,
});

// inc-4b (YUK-403) — 草稿审核面（owner manual gate /drafts）。loom
// screen-draft-review。导航走壳层 prop 注入（同 PracticeRoute），page 自持
// list/detail query + verify/force-enable mutation。
function DraftReviewRoute() {
  const router = useRouter();
  return <DraftReviewPage navigate={(to) => router.history.push(to)} />;
}

const draftsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/drafts',
  component: DraftReviewRoute,
});

// YUK-409 / YUK-413 — 题库面（loom screen-questions）+ 题详情面（loom
// screen-question-detail）。导航走壳层 prop 注入（同 PracticeRoute/DraftReviewRoute），
// page 自持 list query（多轴筛选 + composite 展开 + variant lineage）。row-click →
// /questions/$id（QuestionDetailPage：inline 编辑 + 变体家族 + 约束删除，YUK-413 替
// YUK-409 的 stub）。
function QuestionsRoute() {
  const router = useRouter();
  return <QuestionsPage navigate={(to) => router.history.push(to)} />;
}

const questionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/questions',
  component: QuestionsRoute,
});

function QuestionDetailRouteC() {
  const router = useRouter();
  const { id } = questionDetailRoute.useParams();
  return <QuestionDetailPage id={id} navigate={(to) => router.history.push(to)} />;
}

const questionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/questions/$id',
  component: QuestionDetailRouteC,
});

// M3-T6 (YUK-317) — 知识面：图谱页 + 节点详情页。
function KnowledgeIndexRoute() {
  const router = useRouter();
  return <KnowledgePage navigate={(to) => router.history.push(to)} />;
}

const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/knowledge',
  component: KnowledgeIndexRoute,
});

function KnowledgeDetailRouteC() {
  const router = useRouter();
  const { id } = knowledgeDetailRoute.useParams();
  return <KnowledgeDetailPage id={id} navigate={(to) => router.history.push(to)} />;
}

const knowledgeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/knowledge/$id',
  component: KnowledgeDetailRouteC,
});

// M3-T7 (YUK-317) — 笔记阅读器/编辑器。
function NoteReaderRouteC() {
  const router = useRouter();
  const { id } = noteReaderRoute.useParams();
  return <NoteReaderPage id={id} navigate={(to) => router.history.push(to)} />;
}

const noteReaderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notes/$id',
  component: NoteReaderRouteC,
});

// M5-T4 (YUK-321) — observability 四页 + Coach 周报。
// S13 (YUK-335)：owner override 设计 app.jsx:106「admin separate shell」——admin
// 路由现照常套主 chrome（RootShell .app 壳），不为 admin 特判跳过 chrome
//（见 docs/audit/2026-06-13-visual-gap.md §5 决策点③，owner 已拍板收编）。
function CoachRoute() {
  const router = useRouter();
  return <CoachPage navigate={(to) => router.history.push(to)} />;
}

const coachRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/coach',
  component: CoachRoute,
});

function AdminRunsRoute() {
  const router = useRouter();
  return <AdminRunsSurface navigate={(to) => router.history.push(to)} />;
}

const adminRunsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/runs',
  component: AdminRunsRoute,
});

function AdminCostRoute() {
  const router = useRouter();
  return <AdminCostSurface navigate={(to) => router.history.push(to)} />;
}

const adminCostRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/cost',
  component: AdminCostRoute,
});

function AdminFailuresRoute() {
  const router = useRouter();
  return <AdminFailuresSurface navigate={(to) => router.history.push(to)} />;
}

const adminFailuresRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/failures',
  component: AdminFailuresRoute,
});

function AdminSubjectsRoute() {
  const router = useRouter();
  return <AdminSubjectsSurface navigate={(to) => router.history.push(to)} />;
}

const adminSubjectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/subjects',
  component: AdminSubjectsRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  todayRoute,
  welcomeRoute,
  onboardingUploadRoute,
  placementRoute,
  inboxRoute,
  mistakesRoute,
  agentNotesRoute,
  recordRoute,
  practiceRoute,
  draftsRoute,
  questionsRoute,
  questionDetailRoute,
  knowledgeRoute,
  knowledgeDetailRoute,
  noteReaderRoute,
  coachRoute,
  adminRunsRoute,
  adminCostRoute,
  adminFailuresRoute,
  adminSubjectsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

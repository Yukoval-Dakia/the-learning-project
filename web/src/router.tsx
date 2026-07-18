// M0 (YUK-313) — SPA 路由表。规则（记入 ARCHITECTURE）：capability ui 不 import
// 路由库；导航以 (to: string) => void prop 注入——路由耦合只存在于本壳层。
// M0 仅 /agent-notes 一条 surface；后续 surface 随各 M 在此登记。
import { CopilotDock } from '@/capabilities/copilot/ui/CopilotDock';
import { getWorkbenchSummary } from '@/capabilities/shell/ui/workbench-api';
import { surfacePath } from '@/kernel/ui-surfaces';
import { AppSidebar } from '@/ui/shell/AppSidebar';
import { AppTopbar } from '@/ui/shell/AppTopbar';
import { CommandPalette } from '@/ui/shell/CommandPalette';
import { MobileTabBar } from '@/ui/shell/MobileTabBar';
import { ShellMain } from '@/ui/shell/ShellMain';
import { useQuery } from '@tanstack/react-query';
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

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
        <Outlet />
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

type Navigate = (to: string) => void;
type NavigablePage = ComponentType<{ navigate: Navigate }>;

/**
 * Keep router hooks in the web shell while preserving TanStack Router's preload seam.
 * Each caller supplies an explicit dynamic import so Vite can emit one async route chunk.
 */
function lazyNavigableRoute(loadPage: () => Promise<NavigablePage>) {
  return lazyRouteComponent(async () => {
    const Page = await loadPage();

    function NavigableRoute() {
      const router = useRouter();
      return <Page navigate={(to) => router.history.push(to)} />;
    }

    return { default: NavigableRoute };
  });
}

function RoutePending() {
  return (
    <main className="page route-pending" aria-busy="true">
      <output aria-live="polite">正在打开页面…</output>
    </main>
  );
}

const rootRoute = createRootRoute({ component: RootShell });

// M4-T6 (YUK-319)：工作台上线后 / 落到 /today（旧 SPA 默认 /agent-notes 退位，
// 该页仍在路由表）。
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('root'),
  beforeLoad: () => {
    throw redirect({ to: surfacePath('today') });
  },
});

// M4-T6 (YUK-319/YUK-318) — 工作台 + 提议收件箱。
const TodayRoute = lazyNavigableRoute(() =>
  import('@/capabilities/shell/ui/TodayPage').then((module) => module.default),
);

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('today'),
  component: TodayRoute,
});

// YUK-473 cold-start onboarding flow. /welcome 是 /today 冷拦截（goal_count===0）
// 的 CTA 落点（设定 ①）。Slice 2：/onboarding/upload = 真 OnboardRecord（②a 上传→OCR→
// auto-enroll 尾巴入池）。Slice 3：/placement = 真 ScreenPlacement（③ 探针 start→submit
// (auto_rate→θ̂)→next→end），gated on PLACEMENT_PROBE_ENABLED；goalId 经 `?goal=<id>`
// query 从 Welcome 串过来。导航走壳层 prop 注入（同 TodayRoute）。
const WelcomeRoute = lazyNavigableRoute(() =>
  import('@/capabilities/onboarding/ui/WelcomePage').then((module) => module.default),
);

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('welcome'),
  component: WelcomeRoute,
});

const OnboardingUploadRoute = lazyNavigableRoute(() =>
  import('@/capabilities/onboarding/ui/OnboardRecord').then((module) => module.default),
);

const onboardingUploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('onboarding-upload'),
  component: OnboardingUploadRoute,
});

const PlacementRoute = lazyNavigableRoute(() =>
  import('@/capabilities/onboarding/ui/ScreenPlacement').then((module) => module.default),
);

const placementRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('placement'),
  component: PlacementRoute,
});

// YUK-473 Slice 4 — placement-done 起始档案。placement 的 settling 落到这里
//（?goal 串过来）；「开始日常练习」→ /today。
const ProfileRoute = lazyNavigableRoute(() =>
  import('@/capabilities/onboarding/ui/ScreenProfile').then((module) => module.default),
);

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('profile'),
  component: ProfileRoute,
});

const InboxRoute = lazyNavigableRoute(() =>
  import('@/capabilities/shell/ui/InboxPage').then((module) => module.default),
);

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('inbox'),
  component: InboxRoute,
});

// Usability Step1 (YUK-354) — 错题本面（loom screen-mistakes ScreenMistakes）。闭合
// record→see→practice 死链：RecordPage onSuccess navigate('/mistakes') 此前 404。导航走
// 壳层 prop 注入（同 InboxRoute），page 自持 list query + 客户端 3 轴筛选（科目/状态/归因）。
const MistakesRoute = lazyNavigableRoute(() =>
  import('./routes/MistakesPage').then((module) => module.default),
);

const mistakesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('mistakes'),
  component: MistakesRoute,
});

const AgentNotesRoute = lazyNavigableRoute(() =>
  import('@/capabilities/agency/ui/page').then((module) => module.default),
);

const agentNotesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('agent-notes'),
  component: AgentNotesRoute,
});

const EventDetailRouteC = lazyRouteComponent(async () => {
  const { default: EventDetailPage } = await import(
    '@/capabilities/observability/ui/EventDetailPage'
  );

  function EventDetailRouteComponent() {
    const router = useRouter();
    const { id } = eventDetailRoute.useParams();
    return (
      <EventDetailPage
        id={id}
        navigate={(to) => router.history.push(to)}
        onBack={() => router.history.back()}
      />
    );
  }

  return { default: EventDetailRouteComponent };
});

const eventDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('event-detail'),
  component: EventDetailRouteC,
});

// M1-T6 (YUK-314) — 录入面。query 读写直接走 window.location + history.replace：
// getQuery 只在 VisionTab 的 mount-only 恢复 effect 里读一次（不需要 reactive
// 订阅）；setQuery 是 replace 语义（?ingest= 进行中会话的持久化/清除）。
const RecordRoute = lazyRouteComponent(async () => {
  const { default: RecordPage } = await import('@/capabilities/ingestion/ui/RecordPage');

  function RecordRouteComponent() {
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

  return { default: RecordRouteComponent };
});

const recordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('record'),
  component: RecordRoute,
});

// M2-T6 (YUK-316) — 练习面。query 协议同 RecordRoute：?view=shelf 切卷架，
// setQuery 是 replace 语义（视图切换不进 history 栈）。
const PracticeRoute = lazyRouteComponent(async () => {
  const { default: PracticeFacePage } = await import('@/capabilities/practice/ui/PracticeFacePage');

  function PracticeRouteComponent() {
    const router = useRouter();
    const searchStr = useRouterState({ select: (state) => state.location.searchStr });
    const getQuery = useCallback(
      (key: string) => new URLSearchParams(searchStr).get(key),
      [searchStr],
    );
    const setQuery = useCallback(
      (key: string, value: string | null) => {
        const sp = new URLSearchParams(window.location.search);
        if (value === null) sp.delete(key);
        else sp.set(key, value);
        router.history.replace(
          `${window.location.pathname}${sp.toString() ? `?${sp.toString()}` : ''}`,
        );
      },
      [router],
    );
    return (
      <PracticeFacePage
        navigate={(to) => router.history.push(to)}
        getQuery={getQuery}
        setQuery={setQuery}
      />
    );
  }

  return { default: PracticeRouteComponent };
});

const practiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('practice'),
  component: PracticeRoute,
});

// inc-4b (YUK-403) — 草稿审核面（owner manual gate /drafts）。loom
// screen-draft-review。导航走壳层 prop 注入（同 PracticeRoute），page 自持
// list/detail query + verify/force-enable mutation。
const DraftReviewRoute = lazyNavigableRoute(() =>
  import('@/capabilities/practice/ui/DraftReviewPage').then((module) => module.default),
);

const draftsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('drafts'),
  component: DraftReviewRoute,
});

// YUK-409 / YUK-413 — 题库面（loom screen-questions）+ 题详情面（loom
// screen-question-detail）。导航走壳层 prop 注入（同 PracticeRoute/DraftReviewRoute），
// page 自持 list query（多轴筛选 + composite 展开 + variant lineage）。row-click →
// /questions/$id（QuestionDetailPage：inline 编辑 + 变体家族 + 约束删除，YUK-413 替
// YUK-409 的 stub）。
const QuestionsRoute = lazyNavigableRoute(() =>
  import('@/capabilities/practice/ui/QuestionsPage').then((module) => module.default),
);

const questionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('questions'),
  component: QuestionsRoute,
});

const QuestionDetailRouteC = lazyRouteComponent(async () => {
  const { default: QuestionDetailPage } = await import(
    '@/capabilities/practice/ui/QuestionDetailPage'
  );

  function QuestionDetailRouteComponent() {
    const router = useRouter();
    const { id } = questionDetailRoute.useParams();
    return <QuestionDetailPage id={id} navigate={(to) => router.history.push(to)} />;
  }

  return { default: QuestionDetailRouteComponent };
});

const questionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('question-detail'),
  component: QuestionDetailRouteC,
});

// M3-T6 (YUK-317) — 知识面：图谱页 + 节点详情页。
const KnowledgeIndexRoute = lazyNavigableRoute(() =>
  import('@/capabilities/knowledge/ui/KnowledgePage').then((module) => module.default),
);

const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('knowledge'),
  component: KnowledgeIndexRoute,
});

const KnowledgeDetailRouteC = lazyRouteComponent(async () => {
  const { default: KnowledgeDetailPage } = await import(
    '@/capabilities/knowledge/ui/KnowledgeDetailPage'
  );

  function KnowledgeDetailRouteComponent() {
    const router = useRouter();
    const { id } = knowledgeDetailRoute.useParams();
    return <KnowledgeDetailPage id={id} navigate={(to) => router.history.push(to)} />;
  }

  return { default: KnowledgeDetailRouteComponent };
});

const knowledgeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('knowledge-detail'),
  component: KnowledgeDetailRouteC,
});

// M3-T7 (YUK-317) — 笔记阅读器/编辑器。
const NoteReaderRouteC = lazyRouteComponent(async () => {
  const { default: NoteReaderPage } = await import('@/capabilities/notes/ui/NoteReaderPage');

  function NoteReaderRouteComponent() {
    const router = useRouter();
    const { id } = noteReaderRoute.useParams();
    return <NoteReaderPage id={id} navigate={(to) => router.history.push(to)} />;
  }

  return { default: NoteReaderRouteComponent };
});

const noteReaderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('note-detail'),
  component: NoteReaderRouteC,
});

// M5-T4 (YUK-321) — observability 四页 + Coach 周报。
// S13 (YUK-335)：owner override 设计 app.jsx:106「admin separate shell」——admin
// 路由现照常套主 chrome（RootShell .app 壳），不为 admin 特判跳过 chrome
//（见 docs/audit/2026-06-13-visual-gap.md §5 决策点③，owner 已拍板收编）。
const CoachRoute = lazyNavigableRoute(() =>
  import('@/capabilities/shell/ui/CoachHub').then((module) => module.default),
);

const coachRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('coach'),
  component: CoachRoute,
});

const AdminRunsRoute = lazyNavigableRoute(() =>
  import('@/capabilities/observability/ui/admin-runs').then((module) => module.AdminRunsSurface),
);

const adminRunsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-runs'),
  component: AdminRunsRoute,
});

const AdminCostRoute = lazyNavigableRoute(() =>
  import('@/capabilities/observability/ui/admin-cost').then((module) => module.AdminCostSurface),
);

const adminCostRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-cost'),
  component: AdminCostRoute,
});

const AdminFailuresRoute = lazyNavigableRoute(() =>
  import('@/capabilities/observability/ui/admin-failures').then(
    (module) => module.AdminFailuresSurface,
  ),
);

const adminFailuresRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-failures'),
  component: AdminFailuresRoute,
});

const AdminSubjectsRoute = lazyNavigableRoute(() =>
  import('@/capabilities/observability/ui/subjects').then((module) => module.AdminSubjectsSurface),
);

const adminSubjectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-subjects'),
  component: AdminSubjectsRoute,
});

// YUK-601 — trait 编辑面 detail（TanStack $id 语法；capability 组件零路由库
// import，param 由本 wrapper 读出后以 subjectId prop 注入——design doc v1.1 §0.3）。
const AdminSubjectTraitsRoute = lazyRouteComponent(async () => {
  const { AdminSubjectTraitsSurface } = await import(
    '@/capabilities/observability/ui/subject-traits'
  );

  function AdminSubjectTraitsRouteComponent() {
    const router = useRouter();
    const { id } = adminSubjectTraitsRoute.useParams();
    return <AdminSubjectTraitsSurface subjectId={id} navigate={(to) => router.history.push(to)} />;
  }

  return { default: AdminSubjectTraitsRouteComponent };
});

const adminSubjectTraitsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-subject-detail'),
  component: AdminSubjectTraitsRoute,
});

// YUK-579 — 供题治理覆盖细目表（admin 第五页）。同四页套主 chrome（rootRoute → RootShell）。
const AdminCoverageLatticeRoute = lazyNavigableRoute(() =>
  import('@/capabilities/observability/ui/coverage-lattice').then(
    (module) => module.AdminCoverageLatticeSurface,
  ),
);

const adminCoverageLatticeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-coverage-lattice'),
  component: AdminCoverageLatticeRoute,
});

const AdminConjectureScoresRoute = lazyNavigableRoute(() =>
  import('@/capabilities/observability/ui/conjecture-scores').then(
    (module) => module.AdminConjectureScoresSurface,
  ),
);
const adminConjectureScoresRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-conjecture-scores'),
  component: AdminConjectureScoresRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  todayRoute,
  welcomeRoute,
  onboardingUploadRoute,
  placementRoute,
  profileRoute,
  inboxRoute,
  mistakesRoute,
  agentNotesRoute,
  eventDetailRoute,
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
  adminSubjectTraitsRoute,
  adminCoverageLatticeRoute,
  adminConjectureScoresRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 300,
  defaultPendingMinMs: 300,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

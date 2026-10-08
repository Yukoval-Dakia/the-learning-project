// M0 (YUK-313) — SPA 路由表。规则（记入 ARCHITECTURE）：capability ui 不 import
// 路由库；导航以 (to: string) => void prop 注入——路由耦合只存在于本壳层。
// M0 仅 /agent-notes 一条 surface；后续 surface 随各 M 在此登记。

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
import { useCallback, useEffect } from 'react';
import { loadAgentNotesPage } from '@/capabilities/agency/ui-public';
import { loadRecordPage } from '@/capabilities/ingestion/ui-public';
import { loadKnowledgeDetailPage, loadKnowledgePage } from '@/capabilities/knowledge/ui-public';
import { loadNoteReaderPage, loadNotesPage } from '@/capabilities/notes/ui-public';
import {
  loadAdminConfigSurface,
  loadAdminConjectureScoresSurface,
  loadAdminCostSurface,
  loadAdminCoverageLatticeSurface,
  loadAdminFailuresSurface,
  loadAdminRunsSurface,
  loadAdminSubjectTraitsSurface,
  loadAdminSubjectsSurface,
  loadEventDetailPage,
} from '@/capabilities/observability/ui-public';
import {
  loadOnboardRecordPage,
  loadPlacementPage,
  loadPlacementProfilePage,
  loadWelcomePage,
} from '@/capabilities/onboarding/ui-public';
import {
  loadDraftReviewPage,
  loadPracticeFacePage,
  loadQuestionDetailPage,
  loadQuestionsPage,
} from '@/capabilities/practice/ui-public';
import { loadCoachHub, loadInboxPage, loadTodayPage } from '@/capabilities/shell/ui-public';
import { surfacePath } from '@/kernel/ui-surfaces';
import { RootShell as SharedRootShell } from './RootShell';

function RootShell() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useCallback((to: string) => router.history.push(to), [router]);
  return (
    <SharedRootShell pathname={pathname} navigate={navigate}>
      <Outlet />
    </SharedRootShell>
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
const TodayRoute = import.meta.env.PROD ? StartPageEntry : lazyNavigableRoute(loadTodayPage);

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
const WelcomeRoute = lazyNavigableRoute(loadWelcomePage);

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('welcome'),
  component: WelcomeRoute,
});

const OnboardingUploadRoute = lazyNavigableRoute(loadOnboardRecordPage);

const onboardingUploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('onboarding-upload'),
  component: OnboardingUploadRoute,
});

const PlacementRoute = lazyNavigableRoute(loadPlacementPage);

const placementRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('placement'),
  component: PlacementRoute,
});

// YUK-473 Slice 4 — placement-done 起始档案。placement 的 settling 落到这里
//（?goal 串过来）；「开始日常练习」→ /today。
const ProfileRoute = lazyNavigableRoute(loadPlacementProfilePage);

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('profile'),
  component: ProfileRoute,
});

const InboxRoute = import.meta.env.PROD ? StartPageEntry : lazyNavigableRoute(loadInboxPage);

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('inbox'),
  component: InboxRoute,
});

// Usability Step1 (YUK-354) — 错题本面（loom screen-mistakes ScreenMistakes）。闭合
// record→see→practice 死链：RecordPage onSuccess navigate('/mistakes') 此前 404。导航走
// 壳层 prop 注入（同 InboxRoute），page 自持 list query + 客户端 3 轴筛选（科目/状态/归因）。
// Vite development fallback only. YUK-1359 owns its final removal.
function StartPageEntry() {
  useEffect(() => {
    window.location.replace(window.location.href);
  }, []);
  return <RoutePending />;
}

const MistakesRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyNavigableRoute(() => import('./routes/MistakesPage').then((module) => module.default));

const mistakesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('mistakes'),
  component: MistakesRoute,
});

const AgentNotesRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyNavigableRoute(loadAgentNotesPage);

const agentNotesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('agent-notes'),
  component: AgentNotesRoute,
});

const EventDetailRouteC = lazyRouteComponent(async () => {
  const EventDetailPage = await loadEventDetailPage();

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
  const RecordPage = await loadRecordPage();

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
  const PracticeFacePage = await loadPracticeFacePage();

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
const DraftReviewRoute = lazyNavigableRoute(loadDraftReviewPage);

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
const QuestionsRoute = lazyNavigableRoute(loadQuestionsPage);

const questionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('questions'),
  component: QuestionsRoute,
});

const QuestionDetailRouteC = lazyRouteComponent(async () => {
  const QuestionDetailPage = await loadQuestionDetailPage();

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
const KnowledgeIndexRoute = lazyNavigableRoute(loadKnowledgePage);

const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('knowledge'),
  component: KnowledgeIndexRoute,
});

const KnowledgeDetailRouteC = lazyRouteComponent(async () => {
  const KnowledgeDetailPage = await loadKnowledgeDetailPage();

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

const NotesRoute = lazyNavigableRoute(loadNotesPage);

const notesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('notes'),
  component: NotesRoute,
});

// M3-T7 (YUK-317) — 笔记阅读器/编辑器。
const NoteReaderRouteC = lazyRouteComponent(async () => {
  const NoteReaderPage = await loadNoteReaderPage();

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
const CoachRoute = lazyNavigableRoute(loadCoachHub);

const coachRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('coach'),
  component: CoachRoute,
});

const AdminConfigRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyRouteComponent(async () => {
      const AdminConfigSurface = await loadAdminConfigSurface();
      function AdminConfigRouteComponent() {
        const router = useRouter();
        const searchStr = useRouterState({ select: (state) => state.location.searchStr });
        const getQuery = useCallback(
          (key: string) => new URLSearchParams(searchStr).get(key),
          [searchStr],
        );
        const setQuery = useCallback(
          (key: string, value: string | null) => {
            const params = new URLSearchParams(window.location.search);
            if (value === null) params.delete(key);
            else params.set(key, value);
            router.history.replace(`${window.location.pathname}${params.size ? `?${params}` : ''}`);
          },
          [router],
        );
        return (
          <AdminConfigSurface
            navigate={(to) => router.history.push(to)}
            getQuery={getQuery}
            setQuery={setQuery}
          />
        );
      }
      return { default: AdminConfigRouteComponent };
    });
const adminConfigRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-config'),
  component: AdminConfigRoute,
});

const AdminRunsRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyNavigableRoute(loadAdminRunsSurface);

const adminRunsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-runs'),
  component: AdminRunsRoute,
});

const AdminCostRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyNavigableRoute(loadAdminCostSurface);

const adminCostRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-cost'),
  component: AdminCostRoute,
});

const AdminFailuresRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyNavigableRoute(loadAdminFailuresSurface);

const adminFailuresRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-failures'),
  component: AdminFailuresRoute,
});

const AdminSubjectsRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyNavigableRoute(loadAdminSubjectsSurface);

const adminSubjectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-subjects'),
  component: AdminSubjectsRoute,
});

// YUK-601 — trait 编辑面 detail（TanStack $id 语法；capability 组件零路由库
// import，param 由本 wrapper 读出后以 subjectId prop 注入——design doc v1.1 §0.3）。
const AdminSubjectTraitsRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyRouteComponent(async () => {
      const AdminSubjectTraitsSurface = await loadAdminSubjectTraitsSurface();

      function AdminSubjectTraitsRouteComponent() {
        const router = useRouter();
        const { id } = adminSubjectTraitsRoute.useParams();
        return (
          <AdminSubjectTraitsSurface subjectId={id} navigate={(to) => router.history.push(to)} />
        );
      }

      return { default: AdminSubjectTraitsRouteComponent };
    });

const adminSubjectTraitsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-subject-detail'),
  component: AdminSubjectTraitsRoute,
});

// YUK-579 — 供题治理覆盖细目表（admin 第五页）。同四页套主 chrome（rootRoute → RootShell）。
const AdminCoverageLatticeRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyNavigableRoute(loadAdminCoverageLatticeSurface);

const adminCoverageLatticeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: surfacePath('admin-coverage-lattice'),
  component: AdminCoverageLatticeRoute,
});

const AdminConjectureScoresRoute = import.meta.env.PROD
  ? StartPageEntry
  : lazyNavigableRoute(loadAdminConjectureScoresSurface);
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
  notesRoute,
  noteReaderRoute,
  coachRoute,
  adminConfigRoute,
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

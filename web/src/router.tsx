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
import PracticeFacePage from '@/capabilities/practice/ui/PracticeFacePage';
import CoachPage from '@/capabilities/shell/ui/CoachPage';
import InboxPage from '@/capabilities/shell/ui/InboxPage';
import TodayPage from '@/capabilities/shell/ui/TodayPage';
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';

// M5-T3 (YUK-321) — 根壳：全路由共享一个 CopilotDock 实例（裁决 c：组件归
// copilot 包，路由耦合只存在于本壳层）。
function RootShell() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      <Outlet />
      <CopilotDock pathname={pathname} navigate={(to) => router.history.push(to)} />
    </>
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

function InboxRoute() {
  const router = useRouter();
  return <InboxPage navigate={(to) => router.history.push(to)} />;
}

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxRoute,
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

// M5-T4 (YUK-321) — observability 四页 + Coach 周报。admin 页是独立壳形态
//（design app.jsx:106-114「admin is a separate shell — no main app chrome」，
// 收编 chrome 须 owner 拍板——见 docs/audit/2026-06-13-visual-gap.md §5 决策点③）。
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
  inboxRoute,
  agentNotesRoute,
  recordRoute,
  practiceRoute,
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

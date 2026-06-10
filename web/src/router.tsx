// M0 (YUK-313) — SPA 路由表。规则（记入 ARCHITECTURE）：capability ui 不 import
// 路由库；导航以 (to: string) => void prop 注入——路由耦合只存在于本壳层。
// M0 仅 /agent-notes 一条 surface；后续 surface 随各 M 在此登记。
import AgentNotesPage from '@/capabilities/agent-notes/ui/page';
import RecordPage from '@/capabilities/ingestion/ui/RecordPage';
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouter,
} from '@tanstack/react-router';

const rootRoute = createRootRoute({ component: Outlet });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/agent-notes' });
  },
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

const routeTree = rootRoute.addChildren([indexRoute, agentNotesRoute, recordRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

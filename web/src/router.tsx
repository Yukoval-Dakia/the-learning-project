// M0 (YUK-313) — SPA 路由表。规则（记入 ARCHITECTURE）：capability ui 不 import
// 路由库；导航以 (to: string) => void prop 注入——路由耦合只存在于本壳层。
// M0 仅 /agent-notes 一条 surface；后续 surface 随各 M 在此登记。
import AgentNotesPage from '@/capabilities/agent-notes/ui/page';
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

const routeTree = rootRoute.addChildren([indexRoute, agentNotesRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

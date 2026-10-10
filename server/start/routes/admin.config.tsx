import { createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { Suspense, lazy, useCallback } from 'react';
import { loadAdminConfigSurface } from '@/capabilities/observability/ui-public';
import { startAdminControlClient } from '../admin-control-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadAdminConfigSurface().then((defaultPage) => ({ default: defaultPage })));
function ConfigPage() {
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
    <StartWorkbenchShell pathname="/admin/config">
      <Suspense>
        <Page
          navigate={startNavigate}
          client={startAdminControlClient}
          getQuery={getQuery}
          setQuery={setQuery}
        />
      </Suspense>
    </StartWorkbenchShell>
  );
}
export const Route = createFileRoute('/admin/config')({ ssr: false, component: ConfigPage });

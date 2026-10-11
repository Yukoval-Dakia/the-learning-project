import { createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { Suspense, lazy, useCallback } from 'react';
import { loadPracticeFacePage } from '@/capabilities/practice/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadPracticeFacePage().then((defaultPage) => ({ default: defaultPage })));
function PracticePage() {
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
    <StartWorkbenchShell pathname="/practice">
      <Suspense>
        <Page navigate={startNavigate} getQuery={getQuery} setQuery={setQuery} />
      </Suspense>
    </StartWorkbenchShell>
  );
}
export const Route = createFileRoute('/practice')({ ssr: false, component: PracticePage });

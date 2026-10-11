import { createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { Suspense, lazy, useCallback } from 'react';
import { loadPracticeFacePage, loadPracticeNextPage } from '@/capabilities/practice/ui-public';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadPracticeFacePage().then((defaultPage) => ({ default: defaultPage })));
// REVIEW BUILD ONLY (YUK-1473 checkpoint screenshots) — never merged. ?ui=next shows the new page
// with the companion embedded; the shell's global Copilot dock is off so one dock owns the signal.
const NextPage = lazy(() => loadPracticeNextPage().then((page) => ({ default: page })));
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
  const next = new URLSearchParams(searchStr).get('ui') === 'next';
  return (
    <StartWorkbenchShell pathname="/practice" globalCopilot={!next}>
      <Suspense>
        {next ? (
          <NextPage
            navigate={startNavigate}
            getQuery={getQuery}
            setQuery={setQuery}
            companion="embedded"
          />
        ) : (
          <Page navigate={startNavigate} getQuery={getQuery} setQuery={setQuery} />
        )}
      </Suspense>
    </StartWorkbenchShell>
  );
}
export const Route = createFileRoute('/practice')({ ssr: false, component: PracticePage });

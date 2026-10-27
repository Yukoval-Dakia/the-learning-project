import { Outlet, createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { LibraryClientProvider, loadQuestionLibraryPage } from '@/capabilities/practice/ui-public';
import { startLibraryClient } from '../library-client';
import { StartWorkbenchShell } from '../workbench-shell';

const Page = lazy(() =>
  loadQuestionLibraryPage().then((defaultPage) => ({ default: defaultPage })),
);
export const Route = createFileRoute('/questions')({
  ssr: false,
  component: LibraryPage,
});

function LibraryPage() {
  const router = useRouter();
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const hasDetail = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === '/questions/$id'),
  });
  if (hasDetail) return <Outlet />;
  return (
    <StartWorkbenchShell pathname="/questions">
      <LibraryClientProvider value={startLibraryClient}>
        <Suspense>
          <Page
            searchStr={searchStr}
            navigate={(to) => router.history.push(to)}
            replace={(href) => router.history.replace(href)}
          />
        </Suspense>
      </LibraryClientProvider>
    </StartWorkbenchShell>
  );
}

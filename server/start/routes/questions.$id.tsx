import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { LibraryClientProvider, loadQuestionPage } from '@/capabilities/practice/ui-public';
import { startLibraryClient } from '../library-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadQuestionPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/questions/$id')({
  ssr: false,
  component: LibraryQuestionPage,
});

function LibraryQuestionPage() {
  const { id } = Route.useParams();
  return (
    <StartWorkbenchShell pathname={`/questions/${encodeURIComponent(id)}`}>
      <LibraryClientProvider value={startLibraryClient}>
        <Suspense>
          <Page id={id} navigate={startNavigate} />
        </Suspense>
      </LibraryClientProvider>
    </StartWorkbenchShell>
  );
}

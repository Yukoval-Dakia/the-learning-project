import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type LibraryClient,
  LibraryClientProvider,
  loadQuestionPage,
} from '@/capabilities/practice/ui-public';
import { startLibraryQuestionDetailClient } from '../library-question-detail-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const libraryClient: LibraryClient = { getQuestionFull: startLibraryQuestionDetailClient };
const Page = lazy(() => loadQuestionPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/questions/$id')({
  ssr: false,
  component: LibraryQuestionPage,
});

function LibraryQuestionPage() {
  const { id } = Route.useParams();
  return (
    <StartWorkbenchShell pathname={`/questions/${encodeURIComponent(id)}`}>
      <LibraryClientProvider value={libraryClient}>
        <Suspense>
          <Page id={id} navigate={startNavigate} />
        </Suspense>
      </LibraryClientProvider>
    </StartWorkbenchShell>
  );
}

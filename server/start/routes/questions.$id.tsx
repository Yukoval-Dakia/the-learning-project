import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type LibraryClient,
  LibraryClientProvider,
  loadQuestionPage,
} from '@/capabilities/practice/ui-public';
import { startLibraryDraftDetailClient } from '../library-draft-detail-client';
import {
  startLibraryDraftEnableClient,
  startLibraryDraftForceEnableClient,
} from '../library-draft-promotion-client';
import { startLibraryQuestionDeleteClient } from '../library-question-delete-client';
import { startLibraryQuestionDetailClient } from '../library-question-detail-client';
import { startLibraryQuestionMistakesClient } from '../library-question-mistakes-client';
import { startLibraryQuestionRestoreClient } from '../library-question-restore-client';
import { startLibraryQuestionUpdateClient } from '../library-question-update-client';
import { startLibraryServingActionClient } from '../library-serving-action-client';
import { startWorkbenchClient } from '../workbench-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const libraryClient: LibraryClient = {
  enableDraft: startLibraryDraftEnableClient,
  forceEnableDraft: startLibraryDraftForceEnableClient,
  runServingAction: startLibraryServingActionClient,
  deleteQuestion: startLibraryQuestionDeleteClient,
  patchQuestion: startLibraryQuestionUpdateClient,
  restoreQuestion: startLibraryQuestionRestoreClient,
  listQuestionMistakes: startLibraryQuestionMistakesClient,
  getQuestionKnowledgeOptions: () => startWorkbenchClient.getTree(),
  getDraftDetail: startLibraryDraftDetailClient,
  getQuestionFull: startLibraryQuestionDetailClient,
};
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

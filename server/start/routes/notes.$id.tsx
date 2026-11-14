import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadNoteReaderPage } from '@/capabilities/notes/ui-public';
import { ApiError } from '@/ui/lib/api';
import {
  startNoteEditingBlurClient,
  startNoteEditingHeartbeatClient,
} from '../note-editing-client';
import {
  startNoteAiChangesClient,
  startNotePageClient,
  startNoteReferenceSearchClient,
  startPracticeNotePageClient,
} from '../note-page-client';
import { startNoteQuestionListClient } from '../note-question-list-client';
import { startNoteSaveClient } from '../note-save-client';
import { startWorkbenchClient } from '../workbench-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadNoteReaderPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/notes/$id')({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    entry: typeof search.entry === 'string' ? search.entry : undefined,
    issuance: typeof search.issuance === 'string' ? search.issuance : undefined,
    question: typeof search.question === 'string' ? search.question : undefined,
  }),
  component: NoteReaderPage,
});

function NoteReaderPage() {
  const { id } = Route.useParams();
  const { entry, issuance, question } = Route.useSearch();
  const read = (() => {
    const contextPresent =
      entry !== undefined || issuance !== undefined || question !== undefined;
    const locationComplete =
      entry !== undefined &&
      entry.length > 0 &&
      issuance !== undefined &&
      issuance.length > 0 &&
      question !== undefined &&
      question.length > 0;
    if (contextPresent && !locationComplete) {
      return async () => {
        throw new ApiError(
          'note issuance, question, and entry are required',
          400,
          'validation_error',
        );
      };
    }
    return locationComplete
      ? startPracticeNotePageClient({
          issuance_id: issuance,
          question_id: question,
          entry_knowledge_id: entry,
        })
      : startNotePageClient;
  })();
  return (
    <StartWorkbenchShell pathname={`/notes/${encodeURIComponent(id)}`}>
      <Suspense>
        <Page
          id={id}
          navigate={startNavigate}
          read={read}
          save={startNoteSaveClient}
          readAiChanges={startNoteAiChangesClient}
          undo={startWorkbenchClient.undoAiChange}
          searchReferences={startNoteReferenceSearchClient}
          readQuestions={startNoteQuestionListClient}
          sendHeartbeat={startNoteEditingHeartbeatClient}
          sendBlur={startNoteEditingBlurClient}
        />
      </Suspense>
    </StartWorkbenchShell>
  );
}

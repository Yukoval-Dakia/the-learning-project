import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadNoteReaderPage } from '@/capabilities/notes/ui-public';
import { startNotePageClient } from '../note-page-client';
import { startNoteSaveClient } from '../note-save-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadNoteReaderPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/notes/$id')({
  ssr: false,
  component: NoteReaderPage,
});

function NoteReaderPage() {
  const { id } = Route.useParams();
  return (
    <StartWorkbenchShell pathname={`/notes/${encodeURIComponent(id)}`}>
      <Suspense>
        <Page
          id={id}
          navigate={startNavigate}
          read={startNotePageClient}
          save={startNoteSaveClient}
        />
      </Suspense>
    </StartWorkbenchShell>
  );
}

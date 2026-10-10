import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadNotesPage } from '@/capabilities/notes/ui-public';
import { startNoteListClient } from '../notes-list-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadNotesPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/notes')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/notes">
      <Suspense>
        <Page navigate={startNavigate} list={startNoteListClient} />
      </Suspense>
    </StartWorkbenchShell>
  ),
});

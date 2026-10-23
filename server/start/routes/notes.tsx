import { Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadNotesPage } from '@/capabilities/notes/ui-public';
import { startNoteListClient } from '../notes-list-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadNotesPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/notes')({
  ssr: false,
  component: NotesPage,
});

function NotesPage() {
  const hasDetail = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === '/notes/$id'),
  });
  if (hasDetail) return <Outlet />;
  return (
    <StartWorkbenchShell pathname="/notes">
      <Suspense>
        <Page navigate={startNavigate} list={startNoteListClient} />
      </Suspense>
    </StartWorkbenchShell>
  );
}

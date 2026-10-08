import { createFileRoute } from '@tanstack/react-router';
import MistakesPage from '../../../web/src/routes/MistakesPage';
import { listStartMistakes } from '../mistakes-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

export const Route = createFileRoute('/mistakes')({
  // The retained token is browser-local. Never run a DB loader during anonymous SSR.
  ssr: false,
  component: StartMistakesPage,
});

function StartMistakesPage() {
  return (
    <StartWorkbenchShell pathname="/mistakes">
      <MistakesPage navigate={startNavigate} list={listStartMistakes} />
    </StartWorkbenchShell>
  );
}

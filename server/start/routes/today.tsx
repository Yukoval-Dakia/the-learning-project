import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { AgentNotesBoard, LearningIntentComposer } from '@/capabilities/agency/ui-public';
import { ColdStart } from '@/capabilities/onboarding/ui-public';
import { loadTodayPage } from '@/capabilities/shell/ui-public';
import { startAgentNoteClient } from '../agent-note-client';
import { startPlacementProfileClient } from '../profile-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadTodayPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/today')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/today">
      <Suspense>
        <Page
          navigate={startNavigate}
          getAgentNoteBoard={startAgentNoteClient.getAgentNoteBoard}
          getPlacementProfile={startPlacementProfileClient}
          AgentNotesBoard={AgentNotesBoard}
          LearningIntentComposer={LearningIntentComposer}
          ColdStart={ColdStart}
        />
      </Suspense>
    </StartWorkbenchShell>
  ),
});

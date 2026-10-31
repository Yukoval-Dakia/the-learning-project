import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  AgentNotesBoard,
  LearningIntentComposer,
  useAgentNoteClient,
} from '@/capabilities/agency/ui-public';
import {
  type PlacementProfileClient,
  PlacementProfileClientProvider,
} from '@/capabilities/onboarding/ui-public';
import { loadTodayPage } from '@/capabilities/shell/ui-public';
import { startCoachCalibrationClient } from '../coach-client';
import { startPlacementProfileClient } from '../profile-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const profileClient: PlacementProfileClient = {
  getPlacementProfile: startPlacementProfileClient,
  getCalibrationMaturity: startCoachCalibrationClient,
};

const Page = lazy(() => loadTodayPage().then((defaultPage) => ({ default: defaultPage })));

function TodayWithAgency() {
  const { getAgentNoteBoard } = useAgentNoteClient();
  return (
    <Page
      navigate={startNavigate}
      getAgentNoteBoard={getAgentNoteBoard}
      AgentNotesBoard={AgentNotesBoard}
      LearningIntentComposer={LearningIntentComposer}
    />
  );
}

export const Route = createFileRoute('/today')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/today">
      <PlacementProfileClientProvider value={profileClient}>
        <Suspense>
          <TodayWithAgency />
        </Suspense>
      </PlacementProfileClientProvider>
    </StartWorkbenchShell>
  ),
});

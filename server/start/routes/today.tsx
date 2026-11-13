import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  AgentNotesBoard,
  LearningIntentComposer,
  LearningItemPlanSection,
} from '@/capabilities/agency/ui-public';
import { ColdStart } from '@/capabilities/onboarding/ui-public';
import { loadTodayPage } from '@/capabilities/shell/ui-public';
import { startAgentNoteClient } from '../agent-note-client';
import { startLearningIntentClient } from '../learning-intent-client';
import { startPlacementProfileClient } from '../profile-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const StartLearningIntentComposer: typeof LearningIntentComposer = (props) => (
  <LearningIntentComposer {...props} createProposal={startLearningIntentClient} />
);
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
          LearningIntentComposer={StartLearningIntentComposer}
          LearningItemPlanSection={LearningItemPlanSection}
          ColdStart={ColdStart}
        />
      </Suspense>
    </StartWorkbenchShell>
  ),
});

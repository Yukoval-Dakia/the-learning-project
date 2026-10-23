import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type PlacementClient,
  PlacementClientProvider,
  httpPlacementClient,
  loadPlacementPage,
} from '@/capabilities/onboarding/ui-public';
import { startJudgeRunStatusClient } from '../judge-status-client';
import { startPlacementHeldReleaseClient } from '../placement-held-release-client';
import { startPlacementNextClient } from '../placement-next-client';
import { startPlacementEndClient, startPlacementSessionClient } from '../placement-session-client';
import { startPlacementStartClient } from '../placement-start-client';
import { startPlacementSubmitClient } from '../placement-submit-client';
import { startResponseDraftClient } from '../response-draft-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadPlacementPage().then((defaultPage) => ({ default: defaultPage })));
const placementClient: PlacementClient = {
  ...httpPlacementClient,
  startPlacement: startPlacementStartClient,
  getPlacementSession: startPlacementSessionClient,
  placementNext: startPlacementNextClient,
  releaseHeldPlacement: startPlacementHeldReleaseClient,
  placementEnd: startPlacementEndClient,
  readJudgeRunStatus: startJudgeRunStatusClient,
  saveResponseDraft: startResponseDraftClient,
  submitProbeAnswer: startPlacementSubmitClient,
};
export const Route = createFileRoute('/placement')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/placement">
      <PlacementClientProvider value={placementClient}>
        <Suspense>
          <Page navigate={startNavigate} />
        </Suspense>
      </PlacementClientProvider>
    </StartWorkbenchShell>
  ),
});

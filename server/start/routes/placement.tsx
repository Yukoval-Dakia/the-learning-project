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
import { startPlacementEndClient, startPlacementSessionClient } from '../placement-session-client';
import { startResponseDraftClient } from '../response-draft-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadPlacementPage().then((defaultPage) => ({ default: defaultPage })));
const placementClient: PlacementClient = {
  ...httpPlacementClient,
  getPlacementSession: startPlacementSessionClient,
  releaseHeldPlacement: startPlacementHeldReleaseClient,
  placementEnd: startPlacementEndClient,
  readJudgeRunStatus: startJudgeRunStatusClient,
  saveResponseDraft: startResponseDraftClient,
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

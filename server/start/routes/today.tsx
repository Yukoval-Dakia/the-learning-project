import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
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
export const Route = createFileRoute('/today')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/today">
      <PlacementProfileClientProvider value={profileClient}>
        <Suspense>
          <Page navigate={startNavigate} />
        </Suspense>
      </PlacementProfileClientProvider>
    </StartWorkbenchShell>
  ),
});

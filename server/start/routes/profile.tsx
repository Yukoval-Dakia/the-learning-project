import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type PlacementProfileClient,
  PlacementProfileClientProvider,
  getPlacementProfile,
  loadPlacementProfilePage,
} from '@/capabilities/onboarding/ui-public';
import { startCoachCalibrationClient } from '../coach-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const profileClient: PlacementProfileClient = {
  getPlacementProfile,
  getCalibrationMaturity: startCoachCalibrationClient,
};

const Page = lazy(() =>
  loadPlacementProfilePage().then((defaultPage) => ({ default: defaultPage })),
);
export const Route = createFileRoute('/profile')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/profile">
      <PlacementProfileClientProvider value={profileClient}>
        <Suspense>
          <Page navigate={startNavigate} />
        </Suspense>
      </PlacementProfileClientProvider>
    </StartWorkbenchShell>
  ),
});

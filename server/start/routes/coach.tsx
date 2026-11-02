import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { CalibrationMaturityBadge } from '@/capabilities/onboarding/ui-public';
import { loadCoachHub } from '@/capabilities/shell/ui-public';
import {
  startCoachCalibrationClient,
  startCoachEffectivenessClient,
  startCoachWeeklyClient,
} from '../coach-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadCoachHub().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/coach')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/coach">
      <Suspense>
        <Page
          navigate={startNavigate}
          readWeekly={startCoachWeeklyClient}
          readCalibration={startCoachCalibrationClient}
          CalibrationMaturityBadge={CalibrationMaturityBadge}
          readEffectiveness={startCoachEffectivenessClient}
        />
      </Suspense>
    </StartWorkbenchShell>
  ),
});

import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type GoalClient,
  GoalClientProvider,
  loadWelcomePage,
} from '@/capabilities/onboarding/ui-public';
import { startGoalCreateClient } from '../goal-create-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadWelcomePage().then((defaultPage) => ({ default: defaultPage })));
const goalClient: GoalClient = { createGoal: startGoalCreateClient };
export const Route = createFileRoute('/welcome')({
  ssr: false,
  component: () => (
    <StartWorkbenchShell pathname="/welcome">
      <GoalClientProvider value={goalClient}>
        <Suspense>
          <Page navigate={startNavigate} />
        </Suspense>
      </GoalClientProvider>
    </StartWorkbenchShell>
  ),
});

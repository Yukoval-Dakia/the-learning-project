import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadEventDetailPage } from '@/capabilities/observability/ui-public';
import { startEventDetailClient } from '../event-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadEventDetailPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/events/$id')({
  ssr: false,
  component: EventDetailRoute,
});
function EventDetailRoute() {
  const { id } = Route.useParams();
  return (
    <StartWorkbenchShell pathname={`/events/${encodeURIComponent(id)}`}>
      <Suspense>
        <Page
          id={id}
          navigate={startNavigate}
          onBack={() => window.history.back()}
          client={startEventDetailClient}
        />
      </Suspense>
    </StartWorkbenchShell>
  );
}

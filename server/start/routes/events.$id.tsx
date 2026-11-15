import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadEventDetailPage } from '@/capabilities/observability/ui-public';
import {
  type MisconceptionEvidenceOrigin,
  misconceptionReturnHref,
  readMisconceptionTraceTarget,
  withMisconceptionOrigin,
} from '@/ui/lib/misconception-evidence-routes';
import { startEventDetailClient } from '../event-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadEventDetailPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/events/$id')({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => {
    const target = readMisconceptionTraceTarget(search);
    const origin: MisconceptionEvidenceOrigin | undefined =
      target && typeof search.knowledgeId === 'string' && search.knowledgeId.length > 0
        ? {
            ...target,
            knowledgeId: search.knowledgeId,
            returnToPlan: search.returnTo === 'learning-plan',
          }
        : undefined;
    return { origin };
  },
  component: EventDetailRoute,
});
function EventDetailRoute() {
  const { id } = Route.useParams();
  const { origin } = Route.useSearch();
  return (
    <StartWorkbenchShell pathname={`/events/${encodeURIComponent(id)}`}>
      <Suspense>
        <Page
          id={id}
          navigate={(to) => startNavigate(origin ? withMisconceptionOrigin(to, origin) : to)}
          onBack={() => {
            if (origin) startNavigate(misconceptionReturnHref(origin));
            else window.history.back();
          }}
          client={startEventDetailClient}
        />
      </Suspense>
    </StartWorkbenchShell>
  );
}

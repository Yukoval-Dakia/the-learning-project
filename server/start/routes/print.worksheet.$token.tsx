import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy, useState } from 'react';
import { loadWorksheetPrintPage } from '@/capabilities/practice/ui-public';
import '../../../web/src/globals.css';
import { TokenGate } from '../../../web/src/TokenGate';
import { startWorksheetExportClient } from '../worksheet-export-client';

const Page = lazy(() => loadWorksheetPrintPage().then((defaultPage) => ({ default: defaultPage })));

// Bare document: the render job prints this page, so no workbench shell is mounted. It reads
// <html data-worksheet-state> and window.__tlpWorksheetRegionMap(); `?overlay=1` draws measured regions.
export const Route = createFileRoute('/print/worksheet/$token')({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    overlay: search.overlay === '1' || search.overlay === 1 ? 1 : undefined,
  }),
  component: WorksheetPrintRoute,
});

function WorksheetPrintRoute() {
  const { token } = Route.useParams();
  const { overlay } = Route.useSearch();
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <Suspense>
          <Page token={token} overlay={overlay === 1} readExport={startWorksheetExportClient} />
        </Suspense>
      </TokenGate>
    </QueryClientProvider>
  );
}

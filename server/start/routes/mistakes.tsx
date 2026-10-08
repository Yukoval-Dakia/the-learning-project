import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import '../../../web/src/globals.css';
import { RootShell } from '../../../web/src/RootShell';
import MistakesPage from '../../../web/src/routes/MistakesPage';
import { TokenGate } from '../../../web/src/TokenGate';
import { listStartMistakes } from '../mistakes-client';

export const Route = createFileRoute('/mistakes')({
  // The retained token is browser-local. Never run a DB loader during anonymous SSR.
  ssr: false,
  component: StartMistakesPage,
});

function StartMistakesPage() {
  const [queryClient] = useState(() => new QueryClient());
  const navigate = (to: string) => window.location.assign(to);
  return (
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <RootShell pathname="/mistakes" navigate={navigate}>
          <MistakesPage navigate={navigate} list={listStartMistakes} />
        </RootShell>
      </TokenGate>
    </QueryClientProvider>
  );
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { AgentNoteClientProvider } from '@/capabilities/agency/ui-public';
import { WorkbenchClientProvider } from '@/capabilities/shell/ui-public';
import '../../web/src/globals.css';
import { RootShell } from '../../web/src/RootShell';
import { TokenGate } from '../../web/src/TokenGate';
import { startAgentNoteClient } from './agent-note-client';
import { startWorkbenchClient } from './workbench-client';

export function StartWorkbenchShell({
  pathname,
  children,
  globalCopilot = true,
}: {
  pathname: string;
  children: ReactNode;
  /** REVIEW BUILD ONLY (YUK-1473): false when the page mounts its own embedded companion. */
  globalCopilot?: boolean;
}) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <WorkbenchClientProvider value={startWorkbenchClient}>
          <AgentNoteClientProvider value={startAgentNoteClient}>
            <RootShell pathname={pathname} navigate={startNavigate} globalCopilot={globalCopilot}>
              {children}
            </RootShell>
          </AgentNoteClientProvider>
        </WorkbenchClientProvider>
      </TokenGate>
    </QueryClientProvider>
  );
}

// Document navigation reaches the Start owner or the retained fallback for each path.
export const startNavigate = (to: string) => window.location.assign(to);

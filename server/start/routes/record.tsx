import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type RecordClient,
  RecordClientProvider,
  loadRecordPage,
} from '@/capabilities/ingestion/ui-public';
import { startRecordBlocksClient } from '../record-blocks-client';
import { startRecordSessionCreateClient } from '../record-session-create-client';
import { startRecordSessionsClient } from '../record-session-list-client';
import { startWorkbenchClient } from '../workbench-client';
import { StartWorkbenchShell } from '../workbench-shell';

const recordClient: RecordClient = {
  listSessions: startRecordSessionsClient,
  listBlocks: startRecordBlocksClient,
  listKnowledge: () => startWorkbenchClient.getTree().then((result) => result.rows),
  createSession: startRecordSessionCreateClient,
};
const Page = lazy(() => loadRecordPage().then((defaultPage) => ({ default: defaultPage })));
export const Route = createFileRoute('/record')({
  ssr: false,
  component: RecordPage,
});

function RecordPage() {
  const router = useRouter();
  return (
    <StartWorkbenchShell pathname="/record">
      <RecordClientProvider value={recordClient}>
        <Suspense>
          <Page
            navigate={(to) => router.history.push(to)}
            getQuery={(key) => new URLSearchParams(window.location.search).get(key)}
            setQuery={(key, value) => {
              const sp = new URLSearchParams(window.location.search);
              if (value === null) sp.delete(key);
              else sp.set(key, value);
              router.history.replace(
                `${window.location.pathname}${sp.toString() ? `?${sp.toString()}` : ''}`,
              );
            }}
          />
        </Suspense>
      </RecordClientProvider>
    </StartWorkbenchShell>
  );
}

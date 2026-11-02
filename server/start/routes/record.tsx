import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import {
  type RecordClient,
  RecordClientProvider,
  loadRecordPage,
} from '@/capabilities/ingestion/ui-public';
import { startRecordAskAnswerClient } from '../record-ask-answer-client';
import { startRecordBlocksClient } from '../record-blocks-client';
import { startRecordLaneClient } from '../record-lane-start-client';
import { startRecordManualMistakeClient } from '../record-manual-mistake-client';
import { startRecordPurposeChangeClient } from '../record-purpose-change-client';
import { startRecordPurposeImpactClient } from '../record-purpose-impact-client';
import { startRecordRevertClient } from '../record-revert-client';
import { startRecordSessionCreateClient } from '../record-session-create-client';
import { startRecordSessionDetailClient } from '../record-session-detail-client';
import { startRecordSessionHistoryClient } from '../record-session-history-client';
import { startRecordSessionsClient } from '../record-session-list-client';
import { startKnowledgeTreeClient } from '../workbench-client';
import { StartWorkbenchShell } from '../workbench-shell';

const recordClient: RecordClient = {
  getHistory: startRecordSessionHistoryClient,
  answerAsk: startRecordAskAnswerClient,
  listSessions: startRecordSessionsClient,
  listBlocks: startRecordBlocksClient,
  listKnowledge: () => startKnowledgeTreeClient().then((result) => result.rows),
  createSession: startRecordSessionCreateClient,
  getSession: startRecordSessionDetailClient,
  createWrongAnswer: startRecordManualMistakeClient,
  revertBlock: startRecordRevertClient,
  startLane: startRecordLaneClient,
  getPurposeImpact: startRecordPurposeImpactClient,
  changePurpose: startRecordPurposeChangeClient,
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

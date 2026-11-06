import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { AgentNoteClientProvider } from '@/capabilities/agency/ui-public';
import { CopilotClientProvider } from '@/capabilities/copilot/ui-public';
import { WorkbenchClientProvider } from '@/capabilities/shell/ui-public';
import { SubjectClientProvider } from '@/ui/hooks/subject-client';
import { startIssuanceCreateClient } from './issuance-create-client';
import { startIssuanceStateClient } from './issuance-state-client';
import { startResponseDraftClient } from './response-draft-client';
import '../../web/src/globals.css';
import { RootShell } from '../../web/src/RootShell';
import { TokenGate } from '../../web/src/TokenGate';
import { startAgentNoteClient } from './agent-note-client';
import { startCopilotClient } from './copilot-summary-client';
import { startNotePageClient } from './note-page-client';
import { startPracticeAdviceClient } from './practice-advice-client';
import { startPracticeSubmitClient } from './practice-submit-client';
import { startQuestionCardReadClient } from './question-card-client';
import { startSubjectClient } from './subject-client';
import { startKnowledgeTreeClient, startWorkbenchClient } from './workbench-client';

const confirmationClient = {
  getIssuanceState: startIssuanceStateClient,
  saveResponseDraft: startResponseDraftClient,
};

const questionCardClient = {
  getQuestionCard: startQuestionCardReadClient,
  issueAssessment: startIssuanceCreateClient,
  getIssuanceState: startIssuanceStateClient,
  saveResponseDraft: startResponseDraftClient,
  getAdvice: startPracticeAdviceClient,
  submitReview: startPracticeSubmitClient,
};

export function StartWorkbenchShell({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <WorkbenchClientProvider value={startWorkbenchClient}>
          <AgentNoteClientProvider value={startAgentNoteClient}>
            <SubjectClientProvider value={startSubjectClient}>
              <CopilotClientProvider value={startCopilotClient}>
                <RootShell
                  confirmationClient={confirmationClient}
                  questionCardClient={questionCardClient}
                  pathname={pathname}
                  navigate={startNavigate}
                  readKnowledgeTree={startKnowledgeTreeClient}
                  readNotePage={startNotePageClient}
                >
                  {children}
                </RootShell>
              </CopilotClientProvider>
            </SubjectClientProvider>
          </AgentNoteClientProvider>
        </WorkbenchClientProvider>
      </TokenGate>
    </QueryClientProvider>
  );
}

// Document navigation reaches the Start owner or the retained fallback for each path.
export const startNavigate = (to: string) => window.location.assign(to);

import { createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { Suspense, lazy, useCallback } from 'react';
import {
  type PracticeClient,
  PracticeClientProvider,
  loadPracticeFacePage,
} from '@/capabilities/practice/ui-public';
import { startIssuanceCreateClient } from '../issuance-create-client';
import { startIssuanceStateClient } from '../issuance-state-client';
import { startJudgeRunStatusClient } from '../judge-status-client';
import { startPaperListClient } from '../papers-list-client';
import { startPracticeQuestionDetailClient } from '../practice-question-detail-client';
import { startPracticeStreamClient } from '../practice-stream-client';
import { startPracticeStreamItemClient } from '../practice-stream-item-client';
import { startPracticeRecomposeClient } from '../practice-stream-recompose-client';
import { startPracticeSubmitClient } from '../practice-submit-client';
import { startResponseDraftClient } from '../response-draft-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() => loadPracticeFacePage().then((defaultPage) => ({ default: defaultPage })));
const practiceClient: PracticeClient = {
  advanceStreamItem: startPracticeStreamItemClient,
  getStream: startPracticeStreamClient,
  recomposeStream: startPracticeRecomposeClient,
  getPapers: startPaperListClient,
  getQuestionDetail: startPracticeQuestionDetailClient,
  getIssuanceState: startIssuanceStateClient,
  issueAssessment: startIssuanceCreateClient,
  saveResponseDraft: startResponseDraftClient,
  submitReview: startPracticeSubmitClient,
  readJudgeRunStatus: startJudgeRunStatusClient,
};
function PracticePage() {
  const router = useRouter();
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  // YUK-1510 — `?item=` names the open question. It is not part of the page's scope: getQuery
  // is built without it, so opening or moving on (which writes it) never looks like a scope change.
  const search = new URLSearchParams(searchStr);
  const itemParam = search.get('item');
  search.delete('item');
  const scopeSearch = search.toString();
  const getQuery = useCallback(
    (key: string) => new URLSearchParams(scopeSearch).get(key),
    [scopeSearch],
  );
  const writeItemParam = useCallback(
    (id: string | null, how: 'push' | 'replace') => {
      const next = new URLSearchParams(window.location.search);
      if (id === null) next.delete('item');
      else next.set('item', id);
      const href = `${window.location.pathname}${next.size ? `?${next}` : ''}`;
      if (how === 'push') router.history.push(href);
      else router.history.replace(href);
    },
    [router],
  );
  const historyBack = useCallback(() => router.history.back(), [router]);
  const setQuery = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (value === null) params.delete(key);
      else params.set(key, value);
      router.history.replace(`${window.location.pathname}${params.size ? `?${params}` : ''}`);
    },
    [router],
  );
  return (
    <StartWorkbenchShell pathname="/practice">
      <PracticeClientProvider value={practiceClient}>
        <Suspense>
          <Page
            navigate={startNavigate}
            getQuery={getQuery}
            setQuery={setQuery}
            itemParam={itemParam}
            writeItemParam={writeItemParam}
            historyBack={historyBack}
          />
        </Suspense>
      </PracticeClientProvider>
    </StartWorkbenchShell>
  );
}
export const Route = createFileRoute('/practice')({ ssr: false, component: PracticePage });

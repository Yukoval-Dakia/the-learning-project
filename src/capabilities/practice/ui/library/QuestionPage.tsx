// YUK-1473 — one question (/questions/$id), ordered by what the learner does with it: what it is
// → anything it needs from me → the question itself → my history with it → what to do next →
// looking after it. Drafts, deleted and held questions are the same page with one notice.

import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { setCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import { ToastHost } from '@/ui-next/feedback/ToastHost';
import { Card } from '@/ui-next/primitives/Card';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, UiNextRoot } from '@/ui-next/public';
import { type QuestionFullDetail, focusTitle, isDeleted, isDraft } from './library-api';
import { useLibraryClient } from './library-client';
import { MyHistory } from './MyHistory';
import { NextSteps } from './NextSteps';
import { QuestionBanner } from './QuestionBanner';
import { QuestionEditor } from './QuestionEditor';
import { QuestionNotice } from './QuestionNotice';
import { QuestionPaper } from './QuestionPaper';
import { QuestionTidy } from './QuestionTidy';
import { questionKey } from './use-question-writes';
import './library.css';
import './library-rows.css';
import './question.css';
import './question-history.css';
import './question-edit.css';

function Loaded({
  detail,
  navigate,
}: {
  detail: QuestionFullDetail;
  navigate: (to: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  // The companion sees this question while the page is open (cleared when it leaves).
  const publishFocus = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      setCompanionFocus({ kind: 'question', id: detail.id, title: focusTitle(detail) });
      return () => setCompanionFocus(null);
    },
    [detail],
  );
  const deleted = isDeleted(detail);

  return (
    <main className="qd-main" ref={publishFocus}>
      <QuestionBanner detail={detail} navigate={navigate} />
      <QuestionNotice detail={detail} />
      {editing ? (
        <QuestionEditor detail={detail} onDone={() => setEditing(false)} />
      ) : (
        <QuestionPaper
          detail={detail}
          navigate={navigate}
          onEdit={deleted ? undefined : () => setEditing(true)}
        />
      )}
      <MyHistory detail={detail} navigate={navigate} />
      {!deleted && (
        <NextSteps
          detail={detail}
          lead={detail.serving.servable && !isDraft(detail)}
          navigate={navigate}
        />
      )}
      {!deleted && <QuestionTidy detail={detail} />}
    </main>
  );
}

export default function QuestionPage({
  id,
  navigate,
}: {
  id: string;
  navigate: (to: string) => void;
}) {
  const { getQuestionFull } = useLibraryClient();
  const q = useQuery({ queryKey: questionKey(id), queryFn: () => getQuestionFull(id) });
  const missing = q.error instanceof ApiError && q.error.status === 404;

  return (
    <UiNextRoot className="ql-page qd-page">
      {q.data ? (
        // Re-key per question so local state (editing, open regions) never leaks between questions.
        <Loaded key={q.data.id} detail={q.data} navigate={navigate} />
      ) : (
        <main className="qd-main">
          {q.isLoading && <SkeletonLines rows={8} label="正在载入这道题" />}
          {missing && (
            <Card tone="sunk" className="ql-empty">
              <p>找不到这道题。它可能被合并了，或者链接不完整。</p>
              <Button size="sm" variant="secondary" onClick={() => navigate('/questions')}>
                回到题目
              </Button>
            </Card>
          )}
          {q.isError && !missing && (
            <RetryLine message="这道题没取到。" onRetry={() => void q.refetch()} />
          )}
        </main>
      )}
      <ToastHost />
    </UiNextRoot>
  );
}

import { useQuery } from '@tanstack/react-query';
import type { MouseEvent } from 'react';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { CollapsibleList } from '@/ui/primitives/CollapsibleList';
import { RetryLine, SkeletonLines } from '@/ui-next/public';
import { type QuestionFullDetail, listQuestionMistakes } from './library-api';
import { outcomeWord } from './library-copy';
import {
  type MistakeQuestionSummary,
  type MistakeRecord,
  RECORD_WORDS,
  causeWords,
  groupMistakes,
} from './mistake-read';
import { shortDay } from './QuestionLine';
import { LIBRARY_KEY, useLookups } from './use-library';

type Attempt = QuestionFullDetail['timeline'][number];
type Open = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;

const eventHref = (id: string) => `/events/${encodeURIComponent(id)}`;

function minutes(ms: number | null): string | null {
  if (ms == null) return null;
  const min = Math.round(ms / 60_000);
  return min < 1 ? '不到 1 分钟' : `用了 ${min} 分钟`;
}

function Summary({
  summary,
  causeLabel,
}: {
  summary: MistakeQuestionSummary;
  causeLabel: (id: string) => string;
}) {
  if (summary.effective_wrong_attempt_count === 0) {
    return <p className="qd-summary">做错的记录都已判分更正或撤回，不算做错。</p>;
  }
  return (
    <p className="qd-summary">
      做错 <span className="un-num">{summary.effective_wrong_attempt_count}</span> 次
      {summary.last_effective_wrong_at
        ? `，最近一次 ${shortDay(summary.last_effective_wrong_at)}`
        : ''}
      。原因：{causeWords(summary.primary_cause, causeLabel)}
    </p>
  );
}

function RecordItem({
  record,
  currentPrompt,
  notation,
  causeLabel,
  open,
}: {
  record: MistakeRecord;
  currentPrompt: string;
  notation: string | null;
  causeLabel: (id: string) => string;
  open: Open;
}) {
  const word = RECORD_WORDS[record.standing];
  const promptChanged = record.promptMd.trim() !== currentPrompt.trim();
  return (
    <li className="qd-wrong" data-standing={record.standing}>
      <div className="qd-wrong-head">
        <span className="qd-when un-num">{shortDay(record.createdAtSec)}</span>
        {word && (
          <span className="ql-state" data-tone="neutral">
            {word}
          </span>
        )}
        <a className="qd-evidence" href={eventHref(record.id)} onClick={open(eventHref(record.id))}>
          看证据
        </a>
      </div>
      {promptChanged && (
        <div className="qd-wrong-body">
          <span className="qd-wrong-label">当时题目</span>
          <MathMarkdown className="qd-wrong-text qd-wrong-prompt" notation={notation}>
            {record.promptMd}
          </MathMarkdown>
        </div>
      )}
      <div className="qd-wrong-body">
        <span className="qd-wrong-label">我答</span>
        {record.wrongAnswerMd.trim() ? (
          <MathMarkdown className="qd-wrong-text" notation={notation}>
            {record.wrongAnswerMd}
          </MathMarkdown>
        ) : (
          <span className="qd-quiet">
            {record.wrongAnswerImages.length
              ? `拍了 ${record.wrongAnswerImages.length} 张照片`
              : '没有留下作答'}
          </span>
        )}
      </div>
      <p className="qd-wrong-cause">
        <span className="qd-wrong-label">原因</span>
        {causeWords(record.cause, causeLabel)}
      </p>
      {record.cause?.note && <p className="qd-wrong-note">我的备注：{record.cause.note}</p>}
    </li>
  );
}

/**
 * 我和这道题: a summary of the wrong attempts that still count, then every record (history, each
 * with the prompt as it was then), then every attempt, folded (L5).
 */
export function MyHistory({
  detail,
  navigate,
}: {
  detail: QuestionFullDetail;
  navigate: (to: string) => void;
}) {
  const mistakes = useQuery({
    queryKey: [LIBRARY_KEY, 'question-mistakes', detail.id],
    queryFn: () => listQuestionMistakes(detail.id),
  });
  const { causeLabel } = useLookups();
  const open: Open = (href) => (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(href);
  };
  const group = groupMistakes(mistakes.data?.rows ?? []).find(
    (g) => g.summary.question_id === detail.id,
  );
  const attempts: readonly Attempt[] = detail.timeline;

  return (
    <section className="qd-section" aria-labelledby="qd-history-h">
      <h2 id="qd-history-h" className="qd-section-title">
        我和这道题
      </h2>
      {mistakes.isLoading && <SkeletonLines rows={2} label="正在载入做错的记录" />}
      {mistakes.isError && (
        <RetryLine message="做错的记录没取到。" onRetry={() => void mistakes.refetch()} />
      )}
      {group && (
        <>
          <Summary summary={group.summary} causeLabel={causeLabel} />
          <h3 className="qd-label">做错过的记录</h3>
          <CollapsibleList
            className="qd-wrongs"
            items={group.records}
            renderItem={(record) => (
              <RecordItem
                key={record.id}
                record={record}
                currentPrompt={detail.prompt_md}
                notation={detail.notation}
                causeLabel={causeLabel}
                open={open}
              />
            )}
          />
          {mistakes.data?.next_cursor && <p className="qd-quiet">更早的记录还没列出。</p>}
        </>
      )}
      {mistakes.isSuccess && !group && attempts.length === 0 && (
        <p className="qd-quiet">还没做过这道题。</p>
      )}

      {attempts.length > 0 && (
        <div className="qd-attempts">
          <h3 className="qd-label">每次作答</h3>
          <CollapsibleList
            className="qd-attempt-list"
            items={attempts}
            renderItem={(a) => (
              <li key={a.event_id} className="qd-attempt">
                <span className="qd-when un-num">{shortDay(a.created_at_sec)}</span>
                <span>{a.kind === 'review' ? '复习' : '作答'}</span>
                <span className="qd-attempt-outcome">{outcomeWord(a.outcome)}</span>
                <span className="qd-quiet">{minutes(a.duration_ms)}</span>
                <a
                  className="qd-evidence"
                  href={eventHref(a.event_id)}
                  onClick={open(eventHref(a.event_id))}
                >
                  看证据
                </a>
              </li>
            )}
          />
        </div>
      )}
    </section>
  );
}

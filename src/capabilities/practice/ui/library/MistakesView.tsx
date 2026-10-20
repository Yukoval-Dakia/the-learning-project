import type { ReactNode } from 'react';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { CollapsibleList } from '@/ui/primitives/CollapsibleList';
import { Button, Card, RetryLine, SkeletonLines } from '@/ui-next/public';
import type { LibraryScope } from './library-url';
import { type MistakeQuestion, RECORD_WORDS, causeWords, splitByEffect } from './mistake-read';
import { LoadMore, QuestionLine, shortDay } from './QuestionLine';
import { type LibraryLookups, useMistakeQuestions } from './use-library';

function plainAnswer(md: string): string {
  const text = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function MistakeLine({
  group,
  lookups,
  navigate,
}: {
  group: MistakeQuestion;
  lookups: LibraryLookups;
  navigate: (to: string) => void;
}) {
  const { summary } = group;
  const counted = summary.effective_wrong_attempt_count > 0;
  // The answer shown is from the newest record that still stands, else the newest record.
  const record = group.records.find((r) => r.standing === 'stands') ?? group.records[0];
  const answer = record ? plainAnswer(record.wrongAnswerMd) : '';
  const notation = lookups.notationFor(group.knowledgeIds);
  return (
    <QuestionLine
      id={summary.question_id}
      stem={group.promptMd}
      notation={notation}
      navigate={navigate}
      detail={
        <span className="ql-mine">
          <span className="ql-mine-label">当时答</span>
          {answer ? (
            <MathMarkdown className="ql-mine-text" notation={notation}>
              {answer}
            </MathMarkdown>
          ) : (
            <span className="ql-mine-text">
              {record?.wrongAnswerImages.length ? '（拍的照片）' : '（没有留下作答）'}
            </span>
          )}
          {counted && (
            <span className="ql-mine-cause">
              原因：{causeWords(summary.primary_cause, lookups.causeLabel)}
            </span>
          )}
        </span>
      }
      facts={[
        group.knowledgeIds
          .map((id) => lookups.knowledgeName(id))
          .filter(Boolean)
          .join('、') || null,
        counted
          ? `做错 ${summary.effective_wrong_attempt_count} 次`
          : `${group.records.length} 条记录`,
        summary.last_effective_wrong_at
          ? `最近 ${shortDay(summary.last_effective_wrong_at)}`
          : `最近 ${shortDay(group.latestRecordAtSec)}`,
      ]}
      aside={
        counted ||
        !record ||
        record.standing === 'stands' ||
        record.standing === 'grading_corrected' ? null : (
          <span className="ql-state" data-tone="neutral">
            {RECORD_WORDS[record.standing]}
          </span>
        )
      }
    />
  );
}

function FoldedGroup({
  id,
  title,
  why,
  groups,
  render,
}: {
  id: string;
  title: string;
  why: string;
  groups: readonly MistakeQuestion[];
  render: (group: MistakeQuestion) => ReactNode;
}) {
  if (groups.length === 0) return null;
  return (
    <section className="ql-group" aria-labelledby={id}>
      <header className="ql-group-head">
        <h2 id={id} className="ql-group-title">
          {title} <span className="ql-group-count un-num">{groups.length}</span>
        </h2>
        <p className="ql-group-why">{why}</p>
      </header>
      <CollapsibleList items={groups} renderItem={render} className="ql-list" />
    </section>
  );
}

/**
 * 做错过: questions with records of wrong attempts. These are history, not a claim that the
 * answer is wrong now. A partial read (mistake pages by cursor), so the footer says how many are
 * shown, never a library total.
 */
export function MistakesView({
  scope,
  scoped,
  lookups,
  navigate,
  onClearScope,
}: {
  scope: LibraryScope;
  scoped: boolean;
  lookups: LibraryLookups;
  navigate: (to: string) => void;
  onClearScope: () => void;
}) {
  const { query: q, groups } = useMistakeQuestions(scope);

  if (q.isLoading) return <SkeletonLines rows={5} label="正在载入做错过的题" />;
  if (q.isError) return <RetryLine message="做错过的题没取到。" onRetry={() => void q.refetch()} />;
  if (groups.length === 0 && !q.hasNextPage) {
    return (
      <Card tone="sunk" className="ql-empty">
        <p>
          {scoped
            ? '这个范围里还没有做错过的题。'
            : '还没有做错的记录。练习里答错的题，或者录入的错题，会出现在这里。'}
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={scoped ? onClearScope : () => navigate('/practice')}
        >
          {scoped ? '清除范围' : '去练习'}
        </Button>
      </Card>
    );
  }

  const { standing, gradingCorrected, other } = splitByEffect(groups);
  const render = (group: MistakeQuestion) => (
    <MistakeLine
      key={group.summary.question_id}
      group={group}
      lookups={lookups}
      navigate={navigate}
    />
  );

  return (
    <>
      {standing.length > 0 && <ol className="ql-list">{standing.map(render)}</ol>}
      <FoldedGroup
        id="ql-m-corrected"
        title="判分已更正"
        why="这些题当时判成错，后来判分更正了，不算做错。"
        groups={gradingCorrected}
        render={render}
      />
      <FoldedGroup
        id="ql-m-other"
        title="其他记录"
        why="这些记录已撤回或状态还不确定，没有算进做错次数。"
        groups={other}
        render={render}
      />
      <LoadMore
        shown={groups.length}
        hasMore={q.hasNextPage}
        loading={q.isFetchingNextPage}
        onMore={() => void q.fetchNextPage()}
      />
    </>
  );
}

import { useState } from 'react';
import { Button, Card, RetryLine, SkeletonLines } from '@/ui-next/public';
import { VERIFY_WORDS, kindWord, sourceWord } from './library-copy';
import type { LibraryScope } from './library-url';
import { LoadMore, QuestionLine, shortDay } from './QuestionLine';
import { ReviewBar } from './ReviewBar';
import { useBatchVerify } from './use-batch-verify';
import { useDraftPages } from './use-library';

/**
 * 待审核: questions waiting for you before they can be given out. Tick some and verify them in a
 * batch, or open one to read it whole and decide there.
 */
export function ReviewView({
  scope,
  scoped,
  navigate,
  onClearScope,
}: {
  scope: LibraryScope;
  scoped: boolean;
  navigate: (to: string) => void;
  onClearScope: () => void;
}) {
  const { query: q, rows, total } = useDraftPages(scope);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const batch = useBatchVerify(() => setPicked(new Set()));
  const shown = rows.filter((row) => !skipped.has(row.id));

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allPicked = shown.length > 0 && shown.every((row) => picked.has(row.id));

  if (q.isLoading) return <SkeletonLines rows={5} label="正在载入待审核的题" />;
  if (q.isError) return <RetryLine message="待审核的题没取到。" onRetry={() => void q.refetch()} />;
  if (rows.length === 0) {
    return (
      <Card tone="sunk" className="ql-empty">
        <p>{scoped ? '这个范围里没有待审核的题。' : '没有等你审核的题。'}</p>
        {scoped && (
          <Button size="sm" variant="secondary" onClick={onClearScope}>
            清除范围
          </Button>
        )}
      </Card>
    );
  }

  return (
    <>
      <div className="ql-review-tools">
        <label className="ql-tick-all">
          <input
            type="checkbox"
            className="ql-tick"
            checked={allPicked}
            disabled={batch.progress !== null}
            onChange={(e) =>
              setPicked(e.currentTarget.checked ? new Set(shown.map((r) => r.id)) : new Set())
            }
          />
          全选这里显示的
        </label>
        {skipped.size > 0 && (
          <button
            type="button"
            className="ql-text-btn un-hit"
            onClick={() => setSkipped(new Set())}
          >
            这次跳过了 {skipped.size} 道 · 显示回来
          </button>
        )}
      </div>
      <ol className="ql-list">
        {shown.map((row) => {
          const verify = VERIFY_WORDS[row.verify_status] ?? { word: '还不确定', tone: 'neutral' };
          return (
            <QuestionLine
              key={row.id}
              id={row.id}
              stem={row.prompt_preview}
              navigate={navigate}
              lead={
                <input
                  type="checkbox"
                  className="ql-tick ql-line-tick"
                  aria-label="选中这道题"
                  checked={picked.has(row.id)}
                  disabled={batch.progress !== null}
                  onChange={(e) => toggle(row.id, e.currentTarget.checked)}
                />
              }
              detail={
                row.verify_reason ? (
                  <span className="ql-reason">没通过的原因：{row.verify_reason}</span>
                ) : null
              }
              facts={[
                row.knowledge.map((k) => k.label).join('、') || null,
                kindWord(row.kind),
                sourceWord(row.source),
                shortDay(Date.parse(row.created_at) / 1000),
              ]}
              aside={
                <span className="ql-state" data-tone={verify.tone}>
                  {verify.word}
                </span>
              }
            />
          );
        })}
      </ol>
      <LoadMore
        shown={shown.length}
        total={scoped ? undefined : total}
        hasMore={q.hasNextPage}
        loading={q.isFetchingNextPage}
        onMore={() => void q.fetchNextPage()}
      />
      <ReviewBar
        count={picked.size}
        progress={batch.progress}
        onCancel={() => setPicked(new Set())}
        onVerify={() => void batch.run([...picked])}
        onSkip={() => {
          setSkipped((prev) => new Set([...prev, ...picked]));
          setPicked(new Set());
        }}
      />
    </>
  );
}

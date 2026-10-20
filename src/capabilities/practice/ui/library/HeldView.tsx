import { Button, Card, RetryLine, SkeletonLines } from '@/ui-next/public';
import type { QBankQuestion } from './library-api';
import { HOLD_WORDS, holdWords, kindWord } from './library-copy';
import type { LibraryScope } from './library-url';
import { LoadMore, QuestionLine, shortDay } from './QuestionLine';
import { ServingButton } from './ServingButton';
import { useQuestionPages } from './use-library';

const REASON_ORDER = [...Object.keys(HOLD_WORDS), 'unknown'];

function groupByReason(items: readonly QBankQuestion[]) {
  const groups = new Map<string, QBankQuestion[]>();
  for (const item of items) {
    const reason = item.serving.hold_reason ?? 'unknown';
    const group = groups.get(reason);
    if (group) group.push(item);
    else groups.set(reason, [item]);
  }
  return [...groups.entries()].sort(
    ([a], [b]) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b),
  );
}

/** 暂不出题: held questions grouped by why, each row with the action the server offers. */
export function HeldView({
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
  const q = useQuestionPages('not_servable', scope);
  const pages = q.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const byReason = pages[0]?.byReason ?? {};

  if (q.isLoading) return <SkeletonLines rows={5} label="正在载入暂不出题的题目" />;
  if (q.isError)
    return <RetryLine message="暂不出题的题目没取到。" onRetry={() => void q.refetch()} />;
  if (items.length === 0) {
    return (
      <Card tone="sunk" className="ql-empty">
        <p>{scoped ? '这个范围里没有暂不出题的题目。' : '所有题目都能正常出给你。'}</p>
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
      {groupByReason(items).map(([reason, group]) => {
        const words = holdWords(reason === 'unknown' ? null : reason);
        const count = byReason[reason] ?? group.length;
        return (
          <section key={reason} className="ql-group" aria-labelledby={`ql-held-${reason}`}>
            <header className="ql-group-head">
              <h2 id={`ql-held-${reason}`} className="ql-group-title">
                {words.title} <span className="ql-group-count un-num">{count}</span>
              </h2>
              <p className="ql-group-why">{words.why}</p>
            </header>
            <ol className="ql-list">
              {group.map((item) => (
                <QuestionLine
                  key={item.id}
                  id={item.id}
                  stem={item.prompt_md}
                  notation={item.notation}
                  navigate={navigate}
                  facts={[
                    item.knowledge_labels?.map((k) => k.name).join('、') || null,
                    kindWord(item.kind),
                    item.draft_status === 'draft' && '草稿',
                    item.serving.held_since &&
                      `从 ${shortDay(Date.parse(item.serving.held_since) / 1000)} 起`,
                  ]}
                  aside={<ServingButton serving={item.serving} />}
                />
              ))}
            </ol>
          </section>
        );
      })}
      <LoadMore
        shown={items.length}
        total={pages[0]?.total}
        hasMore={q.hasNextPage}
        loading={q.isFetchingNextPage}
        onMore={() => void q.fetchNextPage()}
      />
    </>
  );
}

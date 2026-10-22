import { Card } from '@/ui-next/primitives/Card';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button } from '@/ui-next/public';
import { difficultyWord, holdWords, kindWord, sourceWord } from './library-copy';
import type { LibraryScope } from './library-url';
import { LoadMore, QuestionLine, shortDay } from './QuestionLine';
import { useQuestionPages } from './use-library';

/** 全部: every question that can be given to you, newest first. */
export function AllView({
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
  const q = useQuestionPages('active', scope);
  const pages = q.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);

  if (q.isLoading) return <SkeletonLines rows={6} label="正在载入题目" />;
  if (q.isError) return <RetryLine message="题目没取到。" onRetry={() => void q.refetch()} />;
  if (items.length === 0) {
    return scoped ? (
      <Card tone="sunk" className="ql-empty">
        <p>这个范围里没有题目。</p>
        <Button size="sm" variant="secondary" onClick={onClearScope}>
          清除范围
        </Button>
      </Card>
    ) : (
      <Card tone="sunk" className="ql-empty">
        <p>还没有题目。拍一道题或上传一份试卷，题目会收到这里。</p>
        <Button size="sm" variant="primary" onClick={() => navigate('/record')}>
          去录入
        </Button>
      </Card>
    );
  }

  return (
    <>
      <ol className="ql-list">
        {items.map((item) => (
          <QuestionLine
            key={item.id}
            id={item.id}
            stem={item.prompt_md}
            notation={item.notation}
            navigate={navigate}
            facts={[
              item.knowledge_labels?.map((k) => k.name).join('、') || null,
              item.is_composite
                ? item.children.length > 0
                  ? `大题 · ${item.children.length} 小题`
                  : '大题'
                : kindWord(item.kind),
              difficultyWord(item.difficulty),
              sourceWord(item.source),
              shortDay(item.created_at_sec),
            ]}
            aside={
              item.serving.servable ? null : (
                <span className="ql-state" data-tone="caution">
                  {holdWords(item.serving.hold_reason).title}
                </span>
              )
            }
          />
        ))}
      </ol>
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

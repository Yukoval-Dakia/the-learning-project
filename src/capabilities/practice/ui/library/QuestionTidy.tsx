import { useState } from 'react';
import { Button, Expand } from '@/ui-next/public';
import type { QuestionAssociationCounts } from '../practice-api';
import type { QuestionFullDetail } from './library-api';
import { useDelete, useDeletePreview, writeErrorText } from './use-question-writes';

function tiesSentence(c: QuestionAssociationCounts): string {
  const parts = [
    c.attempts > 0 && `${c.attempts} 次作答`,
    c.mistakes > 0 && `${c.mistakes} 条做错的记录`,
    c.fsrs_cards > 0 && `${c.fsrs_cards} 张复习卡`,
    c.paper_refs > 0 && `${c.paper_refs} 份试卷`,
    c.children > 0 && `${c.children} 道小题`,
  ].filter(Boolean);
  return parts.length ? `它连着${parts.join('、')}。` : '它没有连着任何记录。';
}

/**
 * 整理: delete, with what it touches shown first. Deleting keeps every record and can be undone
 * from the toast or restored later from this page.
 */
export function QuestionTidy({ detail }: { detail: QuestionFullDetail }) {
  const preview = useDeletePreview(detail.id);
  const remove = useDelete(detail.id);
  const [open, setOpen] = useState(false);
  const ties = preview.data?.associations;
  const children = ties?.children ?? detail.parts.length;

  const ask = () => {
    setOpen(true);
    preview.mutate(detail.parts.length);
  };

  return (
    <section className="qd-section qd-tidy" aria-labelledby="qd-tidy-h">
      <h2 id="qd-tidy-h" className="qd-section-title">
        整理
      </h2>
      <div className="qd-next-row">
        <div className="qd-next-text">
          <span className="qd-next-name">删除这道题</span>
          <span className="qd-quiet">不再出给你；作答和做错的记录都保留，可以恢复。</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls="qd-delete"
          onClick={() => (open ? setOpen(false) : ask())}
        >
          {open ? '算了' : '删除…'}
        </Button>
      </div>
      <Expand open={open} id="qd-delete">
        <div className="qd-confirm">
          {preview.isPending && <p className="qd-quiet">正在看它连着哪些记录…</p>}
          {preview.isError && <p className="qd-error">{writeErrorText(preview.error)}</p>}
          {ties && (
            <>
              <p>
                {tiesSentence(ties)}
                {children > 0 ? '小题会一起删除。' : ''}
              </p>
              <div className="qd-notice-actions">
                <Button
                  size="sm"
                  variant="primary"
                  className="qd-danger"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate(
                      { version: detail.version, children },
                      { onSuccess: () => setOpen(false) },
                    )
                  }
                >
                  {remove.isPending ? '正在删除…' : '确认删除'}
                </Button>
              </div>
              {remove.isError && <p className="qd-error">{writeErrorText(remove.error)}</p>}
            </>
          )}
        </div>
      </Expand>
    </section>
  );
}

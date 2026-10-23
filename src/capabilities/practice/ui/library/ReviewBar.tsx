import { Button } from '@/ui-next/public';
import type { BatchProgress } from './use-batch-verify';

/**
 * The floating bar for ticked drafts (a floating layer, so it is glass, T3). 跳过 says plainly
 * that it only hides the drafts for this visit; nothing is rejected or deleted.
 */
export function ReviewBar({
  count,
  progress,
  onVerify,
  onSkip,
  onCancel,
}: {
  count: number;
  progress: BatchProgress | null;
  onVerify: () => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const open = count > 0 || progress !== null;
  return (
    <section className="ql-bar" data-open={open} inert={!open} aria-label="选中的草稿">
      {progress ? (
        <p className="ql-bar-text" aria-live="polite">
          正在核验 <span className="un-num">{progress.done + 1}</span> /{' '}
          <span className="un-num">{progress.total}</span>，每道要一会儿
        </p>
      ) : (
        <>
          <p className="ql-bar-text">
            选了 <span className="un-num">{count}</span> 道
          </p>
          <div className="ql-bar-actions">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={onSkip}
              title="只在这次查看里不显示，下次打开还在"
            >
              这次先跳过
            </Button>
            <Button size="sm" variant="primary" onClick={onVerify}>
              核验并启用
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

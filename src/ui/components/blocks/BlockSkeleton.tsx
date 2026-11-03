// YUK-1548 §5 — a block that is still being drawn, at the place it will land in the reply:
// 「正在绘制：<title>」 with how much has arrived, or 「正在修正：<title>」 after a refused attempt.
// The card reserves the picture's space so the swap to the real block does not push text around.
// No partial markup is ever shown (the draft frame carries none).

import { LoaderCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import type { BlockDraftView } from './block-fence';
import './blocks.css';

const KIND_NOUN: Record<string, string> = {
  diagram: '流程图',
  figure: '示意图',
  chart: '图表',
};

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

export function BlockSkeleton({
  title,
  kind,
  receivedBytes,
  retrying,
}: BlockDraftView): ReactElement {
  const subject = title ?? (kind ? KIND_NOUN[kind] : undefined) ?? '图';
  const line = `${retrying ? '正在修正' : '正在绘制'}：${subject}`;
  return (
    <figure className="un-blk" data-kind={kind ?? 'pending'} aria-busy="true">
      <div
        className="un-blk-canvas un-blk-canvas-draft"
        data-retrying={retrying ? '' : undefined}
        role="status"
      >
        <p className="un-blk-draft-line">
          <LoaderCircle size={14} aria-hidden="true" className="un-blk-spin" />
          <span className="un-blk-draft-title">{line}</span>
        </p>
        {receivedBytes && receivedBytes > 0 && !retrying ? (
          <p className="un-blk-draft-meta" aria-hidden="true">
            已收到 {sizeText(receivedBytes)}
          </p>
        ) : null}
      </div>
    </figure>
  );
}

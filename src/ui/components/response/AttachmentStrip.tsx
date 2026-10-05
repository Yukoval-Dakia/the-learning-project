// YUK-1051 — 作答附件条（thumb 列表 + 移除）。
//
// ProbeAnswers 的 pa-thumbs 先例一般化：图片缩略图 + 非图片文件 chip；每张可移除
// （键盘可达的真 button，aria-label 带附件名）。绑定范围标记（整组 / 子集）由
// EvaluationGroupPanel 编辑，这里只如实展示。

import './response.css';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

import { AssetEvidencePreview } from './AssetEvidencePreview';
import type { EvidenceAttachment } from './response-types';

export interface AttachmentStripProps {
  attachments: EvidenceAttachment[];
  /** 缺席 = 只读（复盘/回放场景）。 */
  onRemove?: (assetId: string) => void;
  /** 点击图片放大（宿主一般接 EvidenceLightbox）。 */
  onPreview?: (assetId: string) => void;
  disabled?: boolean;
  /** slot_id → 展示名（「第 2 题」），用于子集绑定标记；缺席就只显示「整组」。 */
  slotLabels?: Map<string, string> | Record<string, string>;
}

function slotLabel(slotLabels: AttachmentStripProps['slotLabels'], slotId: string): string {
  if (!slotLabels) return slotId;
  return slotLabels instanceof Map
    ? (slotLabels.get(slotId) ?? slotId)
    : (slotLabels[slotId] ?? slotId);
}

export function AttachmentStrip({
  attachments,
  onRemove,
  onPreview,
  disabled = false,
  slotLabels,
}: AttachmentStripProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="rs-attach" role="group" aria-label="已附证据">
      {attachments.map((att, i) => {
        const name = att.label ?? `附件 ${i + 1}`;
        return (
          <span className="rs-attach-item" key={att.asset_id}>
            {att.kind === undefined || att.kind === 'image' ? (
              <AssetEvidencePreview
                assetId={att.asset_id}
                kind={att.kind}
                label={name}
                variant="thumb"
                onExpand={onPreview}
              />
            ) : (
              <span className="rs-attach-file">
                <LoomIcon
                  name={att.kind === 'audio' ? 'mic' : att.kind === 'video' ? 'record' : 'doc'}
                  size={13}
                />
                {name}
              </span>
            )}
            <span className="rs-attach-bind">
              {att.slot_ids === null
                ? '整组'
                : att.slot_ids.map((id) => slotLabel(slotLabels, id)).join('、') || '未绑定'}
            </span>
            {onRemove && (
              <button
                type="button"
                className="rs-attach-x"
                disabled={disabled}
                onClick={() => onRemove(att.asset_id)}
                aria-label={`移除${name}`}
              >
                <LoomIcon name="close" size={11} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

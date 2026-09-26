// YUK-1051 — 联合判分组面板（§3「整页证据附件」）：附件默认绑定当前 evaluation
// group 整体，关联子集在这里可编辑——绝不由模型切图归属把相邻题答案串用。
//
// 纯 UI：只编辑每个 EvidenceAttachment.slot_ids（null = 整组）；持久化由宿主的
// 草稿/提交契约带走（paper 面把绑定范围展开成各 slot 草稿的 image_refs）。

import { LoomIcon } from '@/ui/primitives/LoomIcon';

import { AssetEvidencePreview } from './AssetEvidencePreview';
import type { EvidenceAttachment } from './response-types';
import './response.css';

export interface EvaluationGroupPanelProps {
  /** 当前 evaluation group 的槽位（作答位置；不是计分权威）。 */
  slots: { id: string; label: string }[];
  /** 组内全部证据附件。 */
  attachments: EvidenceAttachment[];
  /** 改写某个附件的绑定范围。 */
  onAttachmentChange: (assetId: string, next: EvidenceAttachment) => void;
  disabled?: boolean;
  /** 图片放大预览（宿主接 EvidenceLightbox）。 */
  onPreview?: (assetId: string) => void;
}

export function EvaluationGroupPanel({
  slots,
  attachments,
  onAttachmentChange,
  disabled = false,
  onPreview,
}: EvaluationGroupPanelProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="rs-group" data-testid="evaluation-group-panel">
      <div className="rs-group-h">
        <LoomIcon name="layers" size={13} />
        证据归属 · 默认整页绑定全组
      </div>
      {attachments.map((att, i) => {
        const name = att.label ?? `附件 ${i + 1}`;
        const wholeGroup = att.slot_ids === null;
        const bound = new Set(att.slot_ids ?? []);
        const toggleSlot = (slotId: string) => {
          if (disabled) return;
          const next = new Set(bound);
          if (next.has(slotId)) next.delete(slotId);
          else next.add(slotId);
          // 子集全选/空选都归一：空 = 未绑定（不随任何 slot 提交）；全选 ≡ 整组（null），
          // 避免「子集=全集」与「整组」两种写法并存。
          const slotIds = next.size === 0 ? [] : next.size === slots.length ? null : [...next];
          onAttachmentChange(att.asset_id, { ...att, slot_ids: slotIds });
        };
        return (
          <div key={att.asset_id} style={{ marginTop: 'var(--s-2)' }}>
            <div className="rs-attach-item" style={{ display: 'inline-flex' }}>
              <AssetEvidencePreview
                assetId={att.asset_id}
                kind={att.kind}
                label={name}
                variant="thumb"
                onExpand={onPreview}
              />
              <span className="rs-attach-bind">{name}</span>
            </div>
            <div className="rs-group-slots" role="group" aria-label={`${name} 的关联题目`}>
              <button
                type="button"
                className="rs-group-slot"
                aria-pressed={wholeGroup}
                disabled={disabled}
                onClick={() => onAttachmentChange(att.asset_id, { ...att, slot_ids: null })}
              >
                整组
              </button>
              {slots.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className="rs-group-slot"
                  aria-pressed={!wholeGroup && bound.has(s.id)}
                  disabled={disabled}
                  onClick={() => toggleSlot(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <p className="rs-group-note">
        附件默认算作整组的证据；只跟某几题有关的话，点成那几题。判分按你确认的范围用，
        不会拿它去串相邻题的答案。
      </p>
    </div>
  );
}

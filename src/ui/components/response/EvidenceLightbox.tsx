// YUK-1051 — 整页证据查看 modal（本组件族唯一新增 modal，preflight §2）。
// focus-trap / Escape / 关闭后焦点还到触发元素——全部复用既有 useFocusTrap
// （CopilotDrawer 同一套）；无 opacity-gated 入场（红线）。

import './response.css';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import { IconBtn } from '@/ui/primitives/IconBtn';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';

import { AssetEvidencePreview } from './AssetEvidencePreview';
import type { EvidenceKind } from './response-types';

export interface EvidenceLightboxProps {
  open: boolean;
  onClose: () => void;
  assetId: string | null;
  kind?: EvidenceKind;
  label?: string;
}

export function EvidenceLightbox({ open, onClose, assetId, kind, label }: EvidenceLightboxProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, onClose, panelRef);

  if (!open || !assetId) return null;
  return createPortal(
    <div
      className="rs-lightbox-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: native <dialog> 需要 imperative
          showModal()/close()，与 CSS 驱动 + portal + useFocusTrap 模式不兼容（同
          PfCoach/CopilotDrawer 先例）。 */}
      <div className="rs-lightbox" role="dialog" aria-modal="true" aria-label={label ?? '证据查看'} ref={panelRef}>
        <div className="rs-lightbox-head">
          <span className="rs-lightbox-title">{label ?? '证据'}</span>
          <IconBtn icon="close" size={16} title="关闭" onClick={onClose} />
        </div>
        <div className="rs-lightbox-body">
          <AssetEvidencePreview assetId={assetId} kind={kind} label={label} variant="inline" />
        </div>
      </div>
    </div>,
    document.body,
  );
}

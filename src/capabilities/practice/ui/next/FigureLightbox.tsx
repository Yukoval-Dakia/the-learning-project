// YUK-1473 — zoom for a question figure, in the new design language. The retained
// EvidenceLightbox draws the old card style outside the ui-next scope, so this is the same
// behaviour on a glass floating layer (T3): Esc closes, focus stays inside while open and returns
// to the figure afterwards (shared useFocusTrap stack, so one Esc closes one layer).
// It portals to <body> inside its own UiNextRoot: the retained shell's containers must not clip
// or re-anchor a fixed layer.

import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { Button, UiNextRoot } from '@/ui-next/public';

export interface FigureLightboxProps {
  open: boolean;
  onClose: () => void;
  assetId: string;
  label: string;
}

export function FigureLightbox({ open, onClose, assetId, label }: FigureLightboxProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, onClose, panelRef);
  if (!open) return null;
  return createPortal(
    <UiNextRoot className="un-pn-lightbox-root">
      <div className="un-pn-lightbox-layer">
        <button
          type="button"
          className="un-pn-lightbox-scrim"
          aria-label="关闭大图"
          tabIndex={-1}
          onClick={onClose}
        />
        <div
          ref={panelRef}
          className="un-pn-lightbox un-glass"
          role="dialog"
          aria-modal="true"
          aria-label={label}
        >
          <div className="un-pn-lightbox-head">
            <span className="un-pn-lightbox-title">{label}</span>
            <Button variant="quiet" size="sm" onClick={onClose}>
              关闭
            </Button>
          </div>
          <div className="un-pn-lightbox-body">
            <AssetEvidencePreview assetId={assetId} kind="image" label={label} variant="inline" />
          </div>
        </div>
      </div>
    </UiNextRoot>,
    document.body,
  );
}

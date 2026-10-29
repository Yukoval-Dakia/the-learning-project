// YUK-1473 — zoom for a question figure, in the loft design language: a glass floating layer
// (T3). Esc closes, focus stays inside while open and returns to the figure afterwards (shared
// useFocusTrap stack, so one Esc closes one layer). It portals to <body> inside its own
// UiNextRoot: the retained shell's containers must not clip or re-anchor a fixed layer.

import { createPortal } from 'react-dom';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { Button, UiNextRoot } from '@/ui-next/public';

export interface FigureLightboxProps {
  open: boolean;
  presentation?: 'cleanroom';
  onClose: () => void;
  assetId: string;
  label: string;
}

export function FigureLightbox({
  open,
  onClose,
  assetId,
  label,
  presentation,
}: FigureLightboxProps) {
  const trapRef = useFocusTrap(open, onClose);
  if (!open) return null;
  return createPortal(
    <UiNextRoot
      className={
        presentation === 'cleanroom'
          ? 'un-cr un-cr-portal un-ps-lightbox-root'
          : 'un-ps-lightbox-root'
      }
    >
      <div className="un-ps-lightbox-layer">
        <button
          type="button"
          className="un-ps-lightbox-scrim"
          aria-label="关闭大图"
          tabIndex={-1}
          onClick={onClose}
        />
        <div
          ref={trapRef}
          className="un-ps-lightbox un-glass"
          role="dialog"
          aria-modal="true"
          aria-label={label}
        >
          <div className="un-ps-lightbox-head">
            <span className="un-ps-lightbox-title">{label}</span>
            <Button variant="quiet" size="sm" onClick={onClose}>
              关闭
            </Button>
          </div>
          <div className="un-ps-lightbox-body">
            <AssetEvidencePreview assetId={assetId} kind="image" label={label} variant="inline" />
          </div>
        </div>
      </div>
    </UiNextRoot>,
    document.body,
  );
}

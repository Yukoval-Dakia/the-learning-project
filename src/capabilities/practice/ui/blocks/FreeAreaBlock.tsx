// YUK-1497 — free_area input block (presentation spec §1.2): the open_response slot, text_md plus
// photo and other evidence. It reuses the existing EvidenceComposer (text, uploads, attachment
// strip, upload-pending reporting) rather than rebuilding uploads; this block only adds the
// labelled region, the state line and the minimum height from `min_lines`.
import type { CSSProperties } from 'react';
import { EvidenceComposer } from '@/ui/components/response/EvidenceComposer';
import type { EvidenceAttachment } from '@/ui/components/response/response-types';
import type { UploadedAsset } from '@/ui/lib/assets';

import { BlockHead, type BlockStateProps, blockMode } from './shared';

export interface FreeAreaBlockProps extends Omit<BlockStateProps, 'outcome'> {
  /** Accessible name, e.g. 「第 6 题 作答」. */
  label: string;
  /** text_md as typed; null = never answered. */
  text: string | null;
  onTextChange: (text: string) => void;
  attachments: EvidenceAttachment[];
  onAttachmentsChange: (next: EvidenceAttachment[]) => void;
  /** Minimum visible lines of the text area (free_area.min_lines). */
  minLines?: number;
  notation?: string | null;
  placeholder?: string;
  /** The host joins this into its submit gate so a pending upload is never dropped. */
  onUploadingChange?: (uploading: boolean) => void;
  onPreview?: (assetId: string) => void;
  /** Injection point for the upload (defaults to the real uploadAsset). */
  upload?: (file: File) => Promise<UploadedAsset>;
  className?: string;
}

export function FreeAreaBlock({
  label,
  text,
  onTextChange,
  attachments,
  onAttachmentsChange,
  minLines = 3,
  notation = null,
  placeholder,
  onUploadingChange,
  onPreview,
  upload,
  className,
  ...state
}: FreeAreaBlockProps) {
  const mode = blockMode(state);
  return (
    <section
      className={['un-blk', 'un-blk-free', className].filter(Boolean).join(' ')}
      aria-label={label}
      data-mode={mode}
      style={{ '--un-blk-lines': Math.max(1, Math.round(minLines)) } as CSSProperties}
    >
      <BlockHead mode={mode} hint="写下你的作答，也可以拍照或附上文件" />
      <EvidenceComposer
        text={text}
        onTextChange={onTextChange}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        disabled={mode !== 'edit'}
        notation={notation}
        placeholder={placeholder}
        ariaLabel={label}
        onUploadingChange={onUploadingChange}
        onPreview={onPreview}
        {...(upload ? { upload } : {})}
      />
    </section>
  );
}

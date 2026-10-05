// YUK-1051 — 开放作答：通用文字 + 附件证据（grounding §7.2「证明/作文/作图/实验/
// 复杂作品」一行：不用专用学科 widget 才能作答）。
//
//   - 文本原文保留（TextResponse 同一纪律）；附件经 uploadAsset → /api/assets。
//   - 附件默认绑定当前 evaluation group 整体（slot_ids: null）；宿主给了 slotOptions
//     时可在 EvaluationGroupPanel 里改绑子集——绝不由模型切图归属串用相邻题。
//   - 上传失败不丢已成功的同批附件（Promise.allSettled，ProbeAnswers 先例），失败如实
//     报「部分附件上传失败」。
//   - D10 接收面：image/audio/video/pdf/text（白名单/大小在服务端，§10；UI 只做
//     accept 提示，不替代服务端校验）。

import './response.css';
import { useRef, useState } from 'react';

import { type UploadedAsset, uploadAsset } from '@/ui/lib/assets';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

import { AttachmentStrip } from './AttachmentStrip';
import { type EvidenceAttachment, evidenceKindFromMime } from './response-types';
import { TextResponse } from './TextResponse';

/** D10 accept 提示：服务端白名单才是真闸（§10）。 */
export const EVIDENCE_ACCEPT =
  'image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm,video/mp4,video/webm,application/pdf,text/plain,text/markdown,text/csv';

export interface EvidenceComposerProps {
  /** 文字部分原文；null = 从未作答。 */
  text: string | null;
  onTextChange: (text: string) => void;
  attachments: EvidenceAttachment[];
  onAttachmentsChange: (next: EvidenceAttachment[]) => void;
  disabled?: boolean;
  notation?: string | null;
  placeholder?: string;
  ariaLabel?: string;
  /** 注入点（测试/宿主可替换上传实现）；默认真 uploadAsset。 */
  upload?: (file: File) => Promise<UploadedAsset>;
  /** 图片放大预览（宿主接 EvidenceLightbox）。 */
  onPreview?: (assetId: string) => void;
  slotLabels?: Map<string, string> | Record<string, string>;
  /** 收窄接收面（如探针面只判图片）；默认 EVIDENCE_ACCEPT（D10 全口径）。 */
  accept?: string;
  /** 宿主可保留既有单文件失败文案；默认通用的部分成功/失败说明。 */
  uploadErrorMessage?: string;
  /**
   * YUK-1094 — 上传中状态上报宿主。宿主据此把提交入口并入 upload-pending（disable），
   * 避免分片上传尚未落定就提交、丢掉刚选的附件。true 在 onFiles 开始、false 在批次 settle
   * （含失败/异常）时各报一次。
   */
  onUploadingChange?: (uploading: boolean) => void;
}

export function EvidenceComposer({
  text,
  onTextChange,
  attachments,
  onAttachmentsChange,
  disabled = false,
  notation = null,
  placeholder = '写下你的作答——也可以附上照片、录音或文件。',
  ariaLabel = '作答',
  upload = uploadAsset,
  onPreview,
  slotLabels,
  accept = EVIDENCE_ACCEPT,
  uploadErrorMessage = '部分附件上传失败，请重试',
  onUploadingChange,
}: EvidenceComposerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    // YUK-1094 — 上报宿主：无论成功/失败/宿主回调抛错，finally 里必落 false，否则一个卡住
    // 的 uploading=true 会永久 disable 提交入口。
    onUploadingChange?.(true);
    setUploadError(null);
    try {
      // allSettled（非 all）：一个失败不丢同批已成功的附件（ProbeAnswers review-784 先例）。
      const results = await Promise.allSettled(Array.from(files).map((f) => upload(f)));
      const uploaded = results.flatMap((r, i) => {
        if (r.status !== 'fulfilled') return [];
        const file = Array.from(files)[i];
        const asset = r.value;
        return [
          {
            asset_id: asset.id,
            kind: evidenceKindFromMime(asset.mime_type || file.type || null),
            label: file.name || undefined,
            // 默认绑定整个 evaluation group（§3「整页证据附件」）；子集在组面板里改。
            slot_ids: null,
          } satisfies EvidenceAttachment,
        ];
      });
      if (uploaded.length > 0) onAttachmentsChange([...attachments, ...uploaded]);
      if (uploaded.length < results.length) setUploadError(uploadErrorMessage);
    } finally {
      setUploading(false);
      onUploadingChange?.(false);
      // 清空 input：重选同一文件仍能触发 onChange（ProbeAnswers 先例）。
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div>
      <TextResponse
        value={text}
        onChange={onTextChange}
        disabled={disabled || uploading}
        notation={notation}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        showPreview={false}
      />
      <AttachmentStrip
        attachments={attachments}
        onRemove={
          disabled
            ? undefined
            : (assetId) => onAttachmentsChange(attachments.filter((a) => a.asset_id !== assetId))
        }
        onPreview={onPreview}
        disabled={disabled}
        slotLabels={slotLabels}
      />
      {!disabled && (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            multiple
            className="visually-hidden"
            aria-label="添加附件"
            onChange={(e) => void onFiles(e.target.files)}
          />
          <button
            type="button"
            className="rs-attach-addbtn btn btn-ghost btn-sm"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <LoomIcon name="camera" size={14} />
            {uploading ? '上传中…' : '添加附件'}
          </button>
        </div>
      )}
      {uploadError && (
        <div className="rs-ev-pending" role="alert" style={{ color: 'var(--again-ink)' }}>
          <LoomIcon name="alert" size={13} /> {uploadError}
        </div>
      )}
    </div>
  );
}

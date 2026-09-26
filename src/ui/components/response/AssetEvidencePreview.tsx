// YUK-1051 (D10) — 通用媒体证据预览。
//
// 口径（preflight §10，owner 已批准）：
//   - image → inline <img>；audio/video → 原生 controls；PDF → **下载-only**（绝不用
//     iframe PDF viewer）；text → 转义后 <pre>（React 默认转义，不 dangerouslySet）。
//   - 未知/缺 mime → 保守降级为下载 chip，不假装可内联。
//   - 不做录音 / 编辑器 / 代码执行；不承诺 PDF 缩略图。

import './response.css';
import { useEffect, useState } from 'react';

import { fetchAssetObject, peekAssetObject } from '@/ui/lib/assets';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

import { type EvidenceKind, evidenceKindFromMime } from './response-types';

/** 文本预览的截断上限（字符）——证据确认用途，不整篇内联。 */
const TEXT_PREVIEW_MAX_CHARS = 4000;

export interface AssetEvidencePreviewProps {
  assetId: string;
  /** 已知 MIME（如刚上传的 uploadAsset 回执）；缺席时由 content 响应头决定。 */
  mimeType?: string | null;
  /** 已知类别时直给，跳过 mime 推断。 */
  kind?: EvidenceKind;
  /** 无障礙 alt / 下载名展示。 */
  label?: string;
  /** thumb = 附件条小图；inline = 正文内联。 */
  variant?: 'thumb' | 'inline';
  /** thumb 模式下点击图片（宿主一般拿去开 EvidenceLightbox）。 */
  onExpand?: (assetId: string) => void;
}

export function AssetEvidencePreview({
  assetId,
  mimeType,
  kind,
  label,
  variant = 'inline',
  onExpand,
}: AssetEvidencePreviewProps) {
  const [resolved, setResolved] = useState<{ url: string; mimeType: string | null } | null>(() =>
    peekAssetObject(assetId),
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const cached = peekAssetObject(assetId);
    if (cached) {
      setResolved(cached);
      return;
    }
    let cancelled = false;
    fetchAssetObject(assetId)
      .then((obj) => {
        if (!cancelled) setResolved(obj);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  const effectiveKind: EvidenceKind = kind ?? evidenceKindFromMime(mimeType ?? resolved?.mimeType);
  const name = label ?? '附件';

  if (failed) {
    return <span className="rs-ev-pending">附件加载失败</span>;
  }
  if (!resolved) {
    return <span className="rs-ev-pending">加载附件…</span>;
  }

  if (effectiveKind === 'image') {
    const img = (
      <img
        className={variant === 'thumb' ? 'rs-attach-thumb' : 'rs-ev-img'}
        src={resolved.url}
        alt={name}
      />
    );
    if (variant === 'thumb' && onExpand) {
      return (
        <button
          type="button"
          style={{ border: 0, background: 'transparent', padding: 0, cursor: 'zoom-in' }}
          aria-label={`放大查看${name}`}
          onClick={() => onExpand(assetId)}
        >
          {img}
        </button>
      );
    }
    return img;
  }
  // thumb 模式下非图片一律文件 chip（附件条里不塞播放器/下载链）。
  if (variant === 'thumb') {
    const icon = effectiveKind === 'audio' ? 'mic' : effectiveKind === 'video' ? 'record' : 'doc';
    return (
      <span className="rs-attach-file">
        <LoomIcon name={icon} size={13} />
        {name}
      </span>
    );
  }
  if (effectiveKind === 'audio') {
    // 原生 controls：播放是浏览器内建能力，键盘可达；无波形/编辑器（D10 边界）。
    // biome-ignore lint/a11y/useMediaCaption: 学习者自附的作答证据没有字幕轨可挂。
    return <audio className="rs-ev-audio" controls preload="metadata" src={resolved.url} />;
  }
  if (effectiveKind === 'video') {
    // biome-ignore lint/a11y/useMediaCaption: 同上——证据回放，无字幕轨。
    return <video className="rs-ev-video" controls preload="metadata" src={resolved.url} />;
  }
  // pdf / text / other → 下载-only chip（PDF 绝不 iframe；text 由 TextEvidence 内联转义）。
  if (effectiveKind === 'text') {
    return <TextEvidence url={resolved.url} name={name} />;
  }
  return (
    <a className="rs-ev-download" href={resolved.url} download={name}>
      <LoomIcon name="download" size={13} />
      {effectiveKind === 'pdf' ? `${name}（PDF · 下载查看）` : `${name}（下载）`}
    </a>
  );
}

/** text/* 证据：拉取原文、转义内联（React 文本节点默认转义），超长截断并如实标注。 */
function TextEvidence({ url, name }: { url: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (cancelled) return;
        setTruncated(t.length > TEXT_PREVIEW_MAX_CHARS);
        setText(t.slice(0, TEXT_PREVIEW_MAX_CHARS));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (failed) {
    return (
      <a className="rs-ev-download" href={url} download={name}>
        <LoomIcon name="download" size={13} />
        {name}（下载）
      </a>
    );
  }
  if (text === null) return <span className="rs-ev-pending">加载附件…</span>;
  return (
    <>
      <pre className="rs-ev-text">{text}</pre>
      {truncated && <span className="rs-ev-pending">（内容较长，仅预览前 4000 字符）</span>}
    </>
  );
}

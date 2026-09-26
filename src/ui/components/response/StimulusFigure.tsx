// YUK-1051 — 题目图表 / 共享材料渲染（grounding §7.2「题目图表/材料」一行）：
// markdown 内嵌图之外的结构化 figure / 共享材料同版渲染——判分与学生所见引用同版
// 资产（同一个 asset_id）。图片可缩放（EvidenceLightbox），非图片材料走
// AssetEvidencePreview 的 D10 口径。可读替代说明 = caption/alt 必填提示。
import './response.css';
import { useState } from 'react';

import { AssetEvidencePreview } from './AssetEvidencePreview';
import { EvidenceLightbox } from './EvidenceLightbox';
import type { EvidenceKind } from './response-types';

export interface StimulusFigureProps {
  assetId: string;
  /** 图注（同时作 alt 的人类可读来源）。 */
  caption?: string;
  /** 显式替代文本；缺席时用 caption，再退化通用描述。 */
  alt?: string;
  kind?: EvidenceKind;
  /** 图片是否可点开缩放（默认 true；非图片恒不可缩放——audio/pdf 有自己的控件）。 */
  zoomable?: boolean;
}

export function StimulusFigure({
  assetId,
  caption,
  alt,
  kind,
  zoomable = true,
}: StimulusFigureProps) {
  const [zoom, setZoom] = useState(false);
  const label = alt ?? caption ?? '题目配图';
  const isImage = kind === undefined || kind === 'image';
  return (
    <figure className="rs-fig">
      {isImage && zoomable ? (
        <button
          type="button"
          className="rs-fig-body"
          onClick={() => setZoom(true)}
          aria-label={`放大查看${label}`}
        >
          <AssetEvidencePreview assetId={assetId} kind="image" label={label} variant="inline" />
        </button>
      ) : (
        <AssetEvidencePreview assetId={assetId} kind={kind} label={label} variant="inline" />
      )}
      {caption && <figcaption className="rs-fig-cap">{caption}</figcaption>}
      {isImage && zoomable && <div className="rs-fig-zoom">点开可放大</div>}
      <EvidenceLightbox
        open={zoom}
        onClose={() => setZoom(false)}
        assetId={assetId}
        kind="image"
        label={label}
      />
    </figure>
  );
}

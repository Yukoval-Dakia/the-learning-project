// YUK-1548 §3.2 — a `figure` block: a model-drawn SVG the server rebuilt from an allowlist and
// stored as a write-once `svf_` asset. The bytes come through the authenticated asset reader (an
// <img> cannot send the internal-token header) and are shown only as an <img>, on a paper-white
// card in both themes. `long_desc` is read by screen readers through aria-describedby.

import type { ReactElement } from 'react';
import type { FigureBlockT } from '@/core/schema/blocks';
import { useAssetObject } from '@/ui/lib/assets';
import { BlockFailure, BlockFrame, BlockPlaceholder, useLongDescription } from './BlockFrame';
import { SvgImage } from './SvgImage';

export function FigureBlock({ block }: { block: FigureBlockT }): ReactElement {
  const asset = useAssetObject(block.asset.asset_id);
  const description = useLongDescription(block.long_desc);
  // Only `svf_` rows are served as image/svg+xml; anything else is not a figure we can show.
  const unusable = asset.url !== null && asset.mimeType !== 'image/svg+xml';
  const failed = asset.error !== null || unusable;

  return (
    <BlockFrame kind="figure" caption={block.caption} busy={asset.loading}>
      {failed ? (
        <BlockFailure alt={block.alt} source={block.long_desc} sourceLabel="查看图的文字说明" />
      ) : asset.url ? (
        <div className="un-blk-canvas un-blk-paper">
          <SvgImage src={asset.url} alt={block.alt} describedBy={description.id} />
        </div>
      ) : (
        <BlockPlaceholder alt={block.alt} />
      )}
      {failed ? null : description.node}
    </BlockFrame>
  );
}

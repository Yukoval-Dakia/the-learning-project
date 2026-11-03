// YUK-1548 §3.1 — a `diagram` block: the stored Mermaid source, rendered on this device in the
// current theme and shown as an image. Until the render lands the card shows the block's alt;
// a source Mermaid cannot draw shows the alt, 「图无法显示」 and the source as plain text.

import type { ReactElement } from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import type { BlockV1T } from '@/core/schema/blocks';
import { BlockFailure, BlockFrame, BlockPlaceholder } from './BlockFrame';
import {
  getDiagramRender,
  getDiagramTheme,
  getServerDiagramRender,
  getServerDiagramTheme,
  subscribeDiagram,
  subscribeDiagramTheme,
} from './diagram-render';
import { SvgImage } from './SvgImage';

type DiagramBlockT = Extract<BlockV1T, { kind: 'diagram' }>;

export function DiagramBlock({ block }: { block: DiagramBlockT }): ReactElement {
  const { source, alt } = block;
  const theme = useSyncExternalStore(subscribeDiagramTheme, getDiagramTheme, getServerDiagramTheme);
  const subscribe = useCallback(
    (listener: () => void) => subscribeDiagram(theme, source, listener),
    [theme, source],
  );
  const getSnapshot = useCallback(() => getDiagramRender(theme, source), [theme, source]);
  const render = useSyncExternalStore(subscribe, getSnapshot, getServerDiagramRender);

  return (
    <BlockFrame kind="diagram" caption={block.caption} busy={render.status === 'pending'}>
      {render.status === 'ready' ? (
        <div className="un-blk-canvas">
          <SvgImage src={render.src} alt={alt} width={render.width} height={render.height} />
        </div>
      ) : render.status === 'failed' ? (
        <BlockFailure alt={alt} source={source} />
      ) : (
        <BlockPlaceholder alt={alt} />
      )}
    </BlockFrame>
  );
}

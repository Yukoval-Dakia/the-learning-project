// YUK-1473 loft — design sketch, never merged (owner decided A1–A4, 2026-10-11). Sketch of how the 做题 page
// would host a presentation spec: a closed registry from block kind to a renderer that delegates
// to the components that already exist (ui/components/response, ui/lib/math-markdown). The page
// owns layout (R9 split when a passage block exists) and where inputs go; blocks never fetch data.

import type { ReactNode } from 'react';
import type { ResponseSpecT } from '@/core/schema/assessment';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import type { ResponseSet, SlotResponseValue } from '@/ui/components/response/response-types';
import { StimulusFigure } from '@/ui/components/response/StimulusFigure';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import type { Block, FallbackBlock, KnownBlockKind, KnownBlockT } from './presentation-spec';

export interface BlockContext {
  responseSpec: ResponseSpecT;
  responses: ResponseSet;
  onResponse: (slotId: string, value: SlotResponseValue) => void;
  /** material_id -> asset_id from the public issuance DTO. */
  assetOf: (materialId: string) => string | null;
  notation: string | null;
  /** R9 link: focus a slot (questions column) or reveal its anchor (passage column). */
  focusSlot: (slotId: string) => void;
  /** Handwriting area for a photo_or_handwriting slot (canvas + photo fallback), drawn over `under`. */
  renderHandwriting: (slotId: string, under?: ReactNode) => ReactNode;
  /** Tap-between-characters surface for 断句 (structured gap positions). */
  renderBreakTaps: (block: Extract<KnownBlockT, { kind: 'sentence_breaks' }>) => ReactNode;
}

type Renderer<K extends KnownBlockKind> = (
  block: Extract<KnownBlockT, { kind: K }>,
  ctx: BlockContext,
) => ReactNode;

const SLOT_OR_REF = /\{\{(slot|ref):([^}|]+)(?:\|([^}]*))?\}\}/g;

/** Inline markers become numbered, focusable chips; text in between stays markdown. */
function withMarkers(md: string, ctx: BlockContext): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of md.matchAll(SLOT_OR_REF)) {
    const at = m.index ?? 0;
    if (at > last) {
      out.push(
        <MathMarkdown key={`t${at}`} notation={ctx.notation}>
          {md.slice(last, at)}
        </MathMarkdown>,
      );
    }
    const slotId = m[2];
    out.push(
      <button
        key={`m${at}`}
        type="button"
        className={m[1] === 'slot' ? 'un-spec-blank' : 'un-spec-ref'}
        onClick={() => ctx.focusSlot(slotId)}
      >
        {m[3] ?? slotId}
      </button>,
    );
    last = at + m[0].length;
  }
  if (last < md.length) {
    out.push(
      <MathMarkdown key="tail" notation={ctx.notation}>
        {md.slice(last)}
      </MathMarkdown>,
    );
  }
  return out;
}

function slotField(slotId: string, ctx: BlockContext): ReactNode {
  const slot = ctx.responseSpec.slots.find((s) => s.slot_id === slotId);
  const spec = slot ? nativeSlotFieldSpec(slot) : null;
  if (!spec) return null;
  return (
    <ResponseSlotField
      spec={spec}
      value={ctx.responses[slotId]}
      onChange={(v) => ctx.onResponse(slotId, v)}
      notation={ctx.notation}
    />
  );
}

const renderers: { [K in KnownBlockKind]: Renderer<K> } = {
  text: (b, ctx) => <div className="un-spec-text">{withMarkers(b.md, ctx)}</div>,
  passage: (b, ctx) => (
    <article className="un-spec-passage" aria-label={b.title ?? '文章'}>
      {b.title && <h3 className="un-spec-passage-title">{b.title}</h3>}
      {b.paragraphs.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional anchors in a frozen spec
        <p key={`${b.id}-${i}`} data-anchor={`${b.id}:${i}`}>
          {withMarkers(p, ctx)}
        </p>
      ))}
    </article>
  ),
  figure: (b, ctx) => {
    const assetId = ctx.assetOf(b.materialId);
    return assetId ? (
      <StimulusFigure assetId={assetId} alt={b.alt} caption={b.caption} />
    ) : (
      <p className="un-spec-missing">图缺失：{b.alt}</p>
    );
  },
  table: (b, ctx) => (
    <table className="un-spec-table">
      {b.caption && <caption>{b.caption}</caption>}
      <thead>
        <tr>
          {b.header.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {b.rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity in a frozen spec
          <tr key={r}>
            {row.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
              <td key={i}>{typeof c === 'string' ? c : slotField(c.slot, ctx)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
  formula: (b, ctx) => <MathMarkdown notation={ctx.notation}>{`$$${b.tex}$$`}</MathMarkdown>,
  options: (b, ctx) => slotField(b.slotId, ctx),
  matching: (b, ctx) =>
    ctx.renderHandwriting(
      b.slotId,
      <div className="un-spec-match-columns">
        <ul>
          {b.left.map((it) => (
            <li key={it.id}>{`${it.label} ${it.text}`}</li>
          ))}
        </ul>
        <ul>
          {b.right.map((it) => (
            <li key={it.id}>{`${it.label} ${it.text}`}</li>
          ))}
        </ul>
      </div>,
    ),
  sentence_breaks: (b, ctx) => ctx.renderBreakTaps(b),
  ordering: (b, ctx) => slotField(b.slotId, ctx),
  audio: (b, ctx) => {
    const assetId = ctx.assetOf(b.materialId);
    return assetId ? <StimulusFigure assetId={assetId} alt="听力材料" kind="audio" /> : null;
  },
  code: (b) => (
    <pre className="un-spec-code" data-language={b.language}>
      <code>{b.source}</code>
    </pre>
  ),
  sandbox: (b) =>
    b.previewApprovedAt ? (
      <iframe
        className="un-spec-sandbox"
        title={b.alt}
        height={b.height}
        // No allow-same-origin: the frame gets an opaque origin, no cookies, no app storage.
        sandbox="allow-scripts"
        src={`/sandbox-bundles/${b.bundleDigest}.html`}
      />
    ) : null,
  subquestions: (b, ctx) => (
    <ol className="un-spec-subqs">
      {b.items.map((it) => (
        <li key={it.label}>
          <span className="un-spec-subq-label">{it.label}</span>
          {it.blocks.map((child) => (
            <RenderBlock key={child.id} block={child} ctx={ctx} />
          ))}
        </li>
      ))}
    </ol>
  ),
};

function renderFallback(b: FallbackBlock): ReactNode {
  return (
    <div className="un-spec-fallback" data-original-kind={b.originalKind}>
      {b.plainText}
    </div>
  );
}

export function RenderBlock({ block, ctx }: { block: Block; ctx: BlockContext }) {
  if (block.kind === 'fallback') return renderFallback(block);
  const render = renderers[block.kind] as Renderer<typeof block.kind>;
  return <>{render(block as never, ctx)}</>;
}

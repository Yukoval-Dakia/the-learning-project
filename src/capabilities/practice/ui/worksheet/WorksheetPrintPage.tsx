// YUK-1528 — worksheet print page (/print/worksheet/$token). Renders an export as fixed A4 sheets
// for the render job: it waits until the page is final, then reports
// <html data-worksheet-state="ready"> and exposes window.__tlpWorksheetRegionMap(), which measures
// the regions off the same DOM that page.pdf() prints. Layout: docs/design/
// 2026-10-11-worksheet-print-layout.md (B style).
//
// Pipeline, without effects:
//   1. load the export (react-query) and build the plan (pure);
//   2. a hidden measuring stage renders every block at its column width; its ref callback waits
//      for fonts, KaTeX and images, measures heights and runs the pure paginator;
//   3. the sheets render from the pagination; their ref callback waits again, checks nothing
//      spills out of a page body, then marks the document ready.
// Status changes are written to <html> only from ref callbacks and their async continuations.
import './worksheet-print.css';

import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import type { WorksheetExportStateT } from '@/capabilities/practice/api/worksheet-contracts';
import { useAssetUrl } from '@/ui/lib/assets';
import { MathMarkdown } from '@/ui/lib/math-markdown';

import { getWorksheetExport, isExportNotFound } from './worksheet-api';
import { COLUMN_MM, PANEL_INSET_MM, SHEET_MM, type SheetOrientation } from './worksheet-geometry';
import { type WorksheetRegionMapDraft, measureRegionMap } from './worksheet-measure';
import {
  type FlowInput,
  type LaidOutPage,
  type MeasuredBlock,
  type PlacedSegment,
  paginate,
} from './worksheet-paginate';
import {
  type PlanBlock,
  type PlanItem,
  type WorksheetPlan,
  buildWorksheetPlan,
  worksheetQrPayload,
} from './worksheet-plan';
import { settleSubtree } from './worksheet-settle';
import { Anchor, PanelMark, WorksheetQr } from './worksheet-svg';

declare global {
  interface Window {
    /** Render-job hook: measure the region map of the ready sheets (throws when not ready). */
    __tlpWorksheetRegionMap?: () => WorksheetRegionMapDraft;
  }
}

type WorksheetErrorCode = 'export_not_found' | 'load_failed' | 'layout_overflow' | 'asset_failed';

const STATE_ATTR = 'data-worksheet-state';
const ERROR_ATTR = 'data-worksheet-error';

function writeDocState(state: 'loading' | 'ready' | 'error', code?: WorksheetErrorCode): void {
  const html = document.documentElement;
  html.setAttribute(STATE_ATTR, state);
  if (code) html.setAttribute(ERROR_ATTR, code);
  else html.removeAttribute(ERROR_ATTR);
}

function clearDocState(): void {
  document.documentElement.removeAttribute(STATE_ATTR);
  document.documentElement.removeAttribute(ERROR_ATTR);
}

const ERROR_COPY: Record<WorksheetErrorCode, string> = {
  export_not_found: '找不到这份作答卷。可以回到 Loom 重新打开一次。',
  load_failed: '作答卷暂时没能打开，请稍后再试。',
  layout_overflow: '有一道题太长，一页纸放不下，这份作答卷暂时排不出来。',
  asset_failed: '题目里的图片没能加载出来，这份作答卷暂时排不出来，请稍后再试。',
};

const FOOTER_COPY = '做完后在 Loom 里点『传回作答卷』';

// ---------- status views ----------

function StatusView({
  state,
  code,
  detail,
}: {
  state: 'loading' | 'error';
  code?: WorksheetErrorCode;
  detail?: string;
}) {
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      writeDocState(state, code);
      // The render job reads the code; the detail is for whoever opens the console.
      if (state === 'error' && detail) console.error(`worksheet print: ${code} — ${detail}`);
    },
    [state, code, detail],
  );
  return (
    <div ref={attach} className="ws-status" role={state === 'error' ? 'alert' : 'status'}>
      <p className="ws-status-text">
        {state === 'loading' ? '正在排版作答卷…' : ERROR_COPY[code ?? 'load_failed']}
      </p>
    </div>
  );
}

// ---------- small pieces ----------

function Ring({ n, size }: { n: number; size?: 'sm' }) {
  return <span className={size === 'sm' ? 'ws-sl ws-sl-sm' : 'ws-sl'}>{n}</span>;
}

function PrintFigure({
  assetId,
  caption,
  alt,
}: {
  assetId: string;
  caption?: string;
  alt?: string;
}) {
  const asset = useAssetUrl(assetId);
  const label = alt ?? caption ?? '题目配图';
  return (
    <figure className="ws-fig">
      {asset.error ? (
        <span className="ws-fig-wait" role="img" aria-label={label} data-asset-error="true" />
      ) : asset.url ? (
        <img className="ws-fig-img" src={asset.url} alt={label} />
      ) : (
        <span className="ws-fig-wait" data-asset-pending="true" />
      )}
      {caption ? <figcaption className="ws-cap">{caption}</figcaption> : null}
    </figure>
  );
}

function regionData(block: { issuanceId: string; slotId: string; unitIds: string[] }) {
  return {
    'data-issuance': block.issuanceId,
    'data-slot': block.slotId,
    'data-units': JSON.stringify(block.unitIds),
  };
}

function BlockView({
  block,
  notation,
  orientation,
  segment,
}: {
  block: PlanBlock;
  notation: 'katex' | null;
  orientation: SheetOrientation;
  segment: PlacedSegment | null;
}): ReactNode {
  switch (block.type) {
    case 'head':
      return (
        <p className="ws-qh">
          <span className="ws-no">{block.number}</span>
          {block.meta ? <span className="ws-meta">{block.meta}</span> : null}
        </p>
      );
    case 'text':
      return (
        <div className="ws-sub">
          {block.ring != null ? <Ring n={block.ring} /> : null}
          <MathMarkdown className="ws-stem" notation={notation}>
            {block.md}
          </MathMarkdown>
        </div>
      );
    case 'figure':
      return <PrintFigure assetId={block.assetId} caption={block.caption} alt={block.alt} />;
    case 'note':
      return (
        <p className="ws-note">
          {block.ring != null ? <Ring n={block.ring} size="sm" /> : null}
          <span>{block.text}</span>
        </p>
      );
    case 'choice':
      return (
        <div className={block.ring != null ? 'ws-choice ws-choice-ringed' : 'ws-choice'}>
          {block.ring != null ? <Ring n={block.ring} /> : null}
          <ol
            className="ws-opts"
            data-cols={block.columns}
            data-ws-region="choice"
            data-segment="1"
            {...regionData(block)}
          >
            {block.options.map((option) => (
              <li key={option.optionId} className="ws-opt">
                <span
                  className="ws-bb"
                  data-ws-option=""
                  data-option-id={option.optionId}
                  data-order={option.order}
                  data-label={option.label}
                >
                  {option.label}
                </span>
                <MathMarkdown className="ws-opt-md" notation={notation}>
                  {option.md}
                </MathMarkdown>
              </li>
            ))}
          </ol>
        </div>
      );
    case 'writing': {
      const panelMm = segment?.panelMm ?? block.panelMm;
      const innerW = COLUMN_MM[orientation] - PANEL_INSET_MM * 2;
      const innerH = Math.max(0, panelMm - PANEL_INSET_MM * 2);
      const aside = segment?.continued ? '接上页' : segment?.continues ? '下一页接着写' : null;
      return (
        <section className="ws-pn">
          <p className="ws-pn-l">
            <span className="ws-pn-name">
              {block.ring != null ? <Ring n={block.ring} size="sm" /> : null}
              {block.label}
            </span>
            {aside ? <span className="ws-pn-t">{aside}</span> : null}
          </p>
          <div
            className="ws-pn-b"
            style={{ height: `${panelMm}mm` }}
            data-ws-region="writing"
            data-mark={block.mark}
            data-segment={segment?.index ?? 1}
            {...regionData(block)}
          >
            <i className="ws-tk ws-tk-a" />
            <i className="ws-tk ws-tk-b" />
            <i className="ws-tk ws-tk-c" />
            <i className="ws-tk ws-tk-d" />
            <div className="ws-pn-mk">
              <PanelMark mark={block.mark} w={innerW} h={innerH} />
            </div>
          </div>
        </section>
      );
    }
  }
}

function PassageColumn({ item }: { item: PlanItem }) {
  return (
    <>
      <p className="ws-qh">
        <span className="ws-no">{item.number}</span>
        {item.meta ? <span className="ws-meta">{item.meta}</span> : null}
      </p>
      <MathMarkdown className="ws-passage-md" notation={item.notation}>
        {item.passage?.md ?? ''}
      </MathMarkdown>
    </>
  );
}

// ---------- flows ----------

interface Flow {
  key: string;
  orientation: SheetOrientation;
  items: PlanItem[];
  passageItem: PlanItem | null;
}

/** Consecutive plain items share portrait pages; each passage item gets its own landscape run. */
function buildFlows(plan: WorksheetPlan): Flow[] {
  const flows: Flow[] = [];
  for (const item of plan.items) {
    if (item.passage) {
      flows.push({ key: item.key, orientation: 'landscape', items: [item], passageItem: item });
      continue;
    }
    const last = flows[flows.length - 1];
    if (last && !last.passageItem) last.items.push(item);
    else flows.push({ key: item.key, orientation: 'portrait', items: [item], passageItem: null });
  }
  return flows;
}

interface BlockEntry {
  block: PlanBlock;
  item: PlanItem;
}

function blockIndex(plan: WorksheetPlan): Map<string, BlockEntry> {
  const index = new Map<string, BlockEntry>();
  for (const item of plan.items)
    for (const block of item.blocks) index.set(block.key, { block, item });
  return index;
}

/** Header blocks and a stem right before its answer stay with what follows. */
function keepsWithNext(block: PlanBlock, next: PlanBlock | undefined): boolean {
  if (block.type === 'head') return true;
  if (block.type === 'text' && next) return next.type === 'choice' || next.type === 'writing';
  return false;
}

// ---------- the sheet ----------

function Sheet({
  plan,
  orientation,
  page,
  of,
  measured,
  skeleton,
  overlay,
  children,
}: {
  plan: WorksheetPlan;
  orientation: SheetOrientation;
  page: number;
  of: number;
  measured: boolean;
  skeleton?: boolean;
  overlay?: WorksheetRegionMapDraft['pages'][number] | null;
  children?: ReactNode;
}) {
  const size = SHEET_MM[orientation];
  const payload = worksheetQrPayload(plan.token, page, of);
  return (
    <section
      className={`ws-sheet ws-sheet-${orientation}`}
      data-ws-page={measured ? '' : undefined}
      data-ws-skeleton={skeleton ? orientation : undefined}
      data-page={page}
      data-of={of}
      data-orientation={orientation}
      data-w-mm={size.w}
      data-h-mm={size.h}
      data-qr-payload={payload}
    >
      <Anchor corner="tl" />
      <Anchor corner="tr" />
      <Anchor corner="bl" />
      <Anchor corner="br" />
      <header className="ws-hd">
        <p className="ws-hd-l">
          <span className="ws-hd-t">作答卷</span>
          {plan.sourceLine ? <span className="ws-hd-m">{plan.sourceLine}</span> : null}
        </p>
        <div className="ws-hd-r">
          <p className="ws-code">
            <span className="ws-mono">{plan.shortCode}</span>
            <span>
              第 {page}/{of} 页
            </span>
          </p>
          <div className="ws-qr-box">
            <WorksheetQr payload={payload} />
          </div>
        </div>
      </header>
      <main className="ws-body">{children}</main>
      <footer className="ws-ft">
        <span>{FOOTER_COPY}</span>
        <span className="ws-mono">
          {page} / {of}
        </span>
      </footer>
      {overlay ? <OverlayLayer map={overlay} /> : null}
    </section>
  );
}

const mmBox = (rect: { x: number; y: number; w: number; h: number }) => ({
  left: `${rect.x}mm`,
  top: `${rect.y}mm`,
  width: `${rect.w}mm`,
  height: `${rect.h}mm`,
});

/** ?overlay=1: what the measurement function returned, drawn over the sheet. Never printed. */
function OverlayLayer({ map }: { map: WorksheetRegionMapDraft['pages'][number] }) {
  const anchors = [map.anchors.tl, map.anchors.tr, map.anchors.bl, map.anchors.br];
  return (
    <div className="ws-overlay" aria-hidden="true">
      <div className="ws-ov ws-ov-qr" style={mmBox(map.qr.mm)} />
      {anchors.map((anchor) => (
        <div
          key={`${anchor.cx}-${anchor.cy}`}
          className="ws-ov-cross"
          style={{ left: `${anchor.cx}mm`, top: `${anchor.cy}mm` }}
        />
      ))}
      {map.regions.map((region) => (
        <div
          key={region.region_id}
          className={`ws-ov ws-ov-${region.kind}`}
          style={mmBox(region.mm)}
        >
          <span className="ws-ov-tag">
            {region.kind === 'choice' ? '选项' : '作答区'} 第 {region.segment_index ?? 1} 段
          </span>
        </div>
      ))}
      {map.regions.flatMap((region) =>
        (region.options ?? []).map((option) => (
          <div
            key={`${region.region_id}-${option.option_id}`}
            className="ws-ov ws-ov-option"
            style={mmBox(option.mm)}
          />
        )),
      )}
    </div>
  );
}

// ---------- measuring + layout ----------

const PX_TOLERANCE = 0.5;

function heightMm(element: Element, scale: number): number {
  return element.getBoundingClientRect().height * scale;
}

const isPositive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

const rectOk = (rect: { x: number; y: number; w: number; h: number }) =>
  [rect.x, rect.y].every(Number.isFinite) && isPositive(rect.w) && isPositive(rect.h);

/** Never report ready with a page or region the archive would reject as empty or NaN. */
function regionMapProblem(map: WorksheetRegionMapDraft): string | null {
  if (map.pages.length === 0) return 'no pages measured';
  for (const page of map.pages) {
    if (!isPositive(page.size_mm.w) || !isPositive(page.size_mm.h)) {
      return `page ${page.page}: size is not positive`;
    }
    if (!rectOk(page.qr.mm)) return `page ${page.page}: QR box is not positive`;
    for (const anchor of [page.anchors.tl, page.anchors.tr, page.anchors.bl, page.anchors.br]) {
      if (!Number.isFinite(anchor.cx) || !Number.isFinite(anchor.cy) || !isPositive(anchor.size)) {
        return `page ${page.page}: an anchor is not measurable`;
      }
    }
    for (const region of page.regions) {
      if (!rectOk(region.mm)) return `region ${region.region_id}: rect is not positive`;
      for (const option of region.options ?? []) {
        if (!rectOk(option.mm)) return `region ${region.region_id}: an option circle is empty`;
      }
    }
  }
  return null;
}

function measureFlows(
  stage: HTMLElement,
  flows: Flow[],
): { bodyMm: Record<SheetOrientation, number>; inputs: FlowInput[] } | { error: string } {
  const skeleton = (orientation: SheetOrientation) =>
    stage.querySelector<HTMLElement>(`[data-ws-skeleton="${orientation}"]`);
  const portrait = skeleton('portrait');
  const landscape = skeleton('landscape');
  if (!portrait || !landscape) return { error: 'measuring stage is incomplete' };
  const scale = SHEET_MM.portrait.w / portrait.getBoundingClientRect().width;
  if (!Number.isFinite(scale) || scale <= 0) return { error: 'measuring stage has no width' };
  const bodyOf = (sheet: HTMLElement) => {
    const body = sheet.querySelector('.ws-body');
    return body ? heightMm(body, scale) : 0;
  };
  const bodyMm = { portrait: bodyOf(portrait), landscape: bodyOf(landscape) };
  if (!isPositive(bodyMm.portrait) || !isPositive(bodyMm.landscape)) {
    return { error: 'page body measured as empty' };
  }

  const measuredByKey = new Map<string, number>();
  for (const element of stage.querySelectorAll<HTMLElement>('[data-measure]')) {
    measuredByKey.set(element.getAttribute('data-measure') ?? '', heightMm(element, scale));
  }
  // Every block must have a real, positive height; a hidden or unlaid-out stage reads 0 or NaN.
  for (const flow of flows) {
    const keys = [
      ...flow.items.flatMap((item) => item.blocks.map((block) => block.key)),
      ...(flow.passageItem?.passage ? [flow.passageItem.passage.key] : []),
    ];
    for (const key of keys) {
      if (!isPositive(measuredByKey.get(key))) return { error: `block ${key} measured as empty` };
    }
  }
  const inputs: FlowInput[] = flows.map((flow) => {
    const blocks: MeasuredBlock[] = [];
    const flat = flow.items.flatMap((item) => item.blocks);
    flat.forEach((block, position) => {
      const height = measuredByKey.get(block.key) ?? 0;
      blocks.push({
        key: block.key,
        heightMm: height,
        split:
          block.type === 'writing'
            ? { labelMm: Math.max(0, height - block.panelMm), panelMm: block.panelMm }
            : null,
        keepWithNext: keepsWithNext(block, flat[position + 1]),
      });
    });
    const passageKey = flow.passageItem?.passage?.key;
    return {
      key: flow.key,
      orientation: flow.orientation,
      passage: passageKey
        ? { key: passageKey, heightMm: measuredByKey.get(passageKey) ?? 0 }
        : null,
      blocks,
    };
  });
  return { bodyMm, inputs };
}

const overflowsX = (element: Element) => element.scrollWidth > element.clientWidth + 1;
const overflowsY = (element: Element) => element.scrollHeight > element.clientHeight + 1;

/**
 * Nothing may be clipped off the paper. `.ws-body` is overflow:hidden, so a mismeasured block, a
 * passage taller than its column, wide content or a body pushed into the footer would otherwise
 * vanish silently. Returns what overflowed, or null.
 */
function sheetsOverflow(root: HTMLElement): string | null {
  for (const sheet of root.querySelectorAll('[data-ws-page]')) {
    const page = sheet.getAttribute('data-page');
    const body = sheet.querySelector('.ws-body');
    const footer = sheet.querySelector('.ws-ft');
    if (!body || !footer) return `page ${page}: body or footer missing`;
    const bodyBox = body.getBoundingClientRect();
    if (bodyBox.bottom > footer.getBoundingClientRect().top + PX_TOLERANCE) {
      return `page ${page}: body runs into the footer`;
    }
    if (overflowsY(body) || overflowsX(body)) return `page ${page}: body content is clipped`;
    for (const column of body.querySelectorAll('.ws-split, .ws-passage, .ws-qs')) {
      if (overflowsX(column) || overflowsY(column)) return `page ${page}: a column is clipped`;
    }
    // Direct content of the body and of both columns ends inside the body.
    for (const element of body.querySelectorAll(
      ':scope > *, .ws-passage > *, .ws-qs > *, .ws-blk',
    )) {
      const box = element.getBoundingClientRect();
      if (box.bottom > bodyBox.bottom + PX_TOLERANCE || box.right > bodyBox.right + PX_TOLERANCE) {
        return `page ${page}: content spills out of the body`;
      }
      if (element.classList.contains('ws-blk') && overflowsX(element)) {
        return `page ${page}: a block is wider than its column`;
      }
    }
  }
  return null;
}

/** Every placed key must resolve to a plan block (and every passage page to its item). */
function unresolvedPlacement(
  pages: readonly LaidOutPage[],
  index: Map<string, BlockEntry>,
  plan: WorksheetPlan,
): string | null {
  for (const page of pages) {
    if (page.passageKey && !plan.items.some((item) => item.passage?.key === page.passageKey)) {
      return page.passageKey;
    }
    for (const placement of page.placements) {
      if (!index.has(placement.key)) return placement.key;
    }
  }
  return null;
}

function Sheets({ plan, overlay }: { plan: WorksheetPlan; overlay: boolean }) {
  const flows = useMemo(() => buildFlows(plan), [plan]);
  const index = useMemo(() => blockIndex(plan), [plan]);
  const math = plan.items.some((item) => item.notation === 'katex');
  const [pages, setPages] = useState<LaidOutPage[] | null>(null);
  const [failure, setFailure] = useState<{ code: WorksheetErrorCode; detail: string } | null>(null);
  const [overlayMap, setOverlayMap] = useState<WorksheetRegionMapDraft | null>(null);

  // Step 2: the measuring stage settles, is measured, and the paginator lays out the pages.
  const attachStage = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      let cancelled = false;
      writeDocState('loading');
      settleSubtree(node, { math, isCancelled: () => cancelled }).then(
        () => {
          if (cancelled) return;
          const measured = measureFlows(node, flows);
          if ('error' in measured) {
            setFailure({ code: 'layout_overflow', detail: measured.error });
            return;
          }
          const result = paginate(measured.inputs, measured.bodyMm);
          if (!result.ok) {
            setFailure({ code: 'layout_overflow', detail: `block ${result.key} exceeds a page` });
            return;
          }
          const unresolved = unresolvedPlacement(result.pages, index, plan);
          if (unresolved) {
            setFailure({ code: 'layout_overflow', detail: `placement ${unresolved} has no block` });
            return;
          }
          setPages(result.pages);
        },
        (error: unknown) => {
          if (cancelled) return;
          setFailure({ code: 'asset_failed', detail: String(error) });
        },
      );
      return () => {
        cancelled = true;
      };
    },
    [flows, index, plan, math],
  );

  // Step 3: the sheets settle; nothing may spill out of a body; then the document is ready.
  const attachSheets = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      let cancelled = false;
      settleSubtree(node, { math, isCancelled: () => cancelled }).then(
        () => {
          if (cancelled) return;
          const overflow = sheetsOverflow(node);
          if (overflow) {
            setFailure({ code: 'layout_overflow', detail: overflow });
            return;
          }
          const map = measureRegionMap(node);
          const problem = regionMapProblem(map);
          if (problem) {
            setFailure({ code: 'layout_overflow', detail: problem });
            return;
          }
          writeDocState('ready');
          if (overlay) setOverlayMap(map);
        },
        (error: unknown) => {
          if (cancelled) return;
          setFailure({ code: 'asset_failed', detail: String(error) });
        },
      );
      return () => {
        cancelled = true;
      };
    },
    [math, overlay],
  );

  if (failure) return <StatusView state="error" code={failure.code} detail={failure.detail} />;

  const total = pages?.length ?? 0;
  return (
    <>
      {/* The stage stays mounted: it keeps the image object URLs alive for the sheets. */}
      <div className="ws-stage-host" aria-hidden="true">
        <div ref={attachStage} className="ws-stage">
          <Sheet plan={plan} orientation="portrait" page={1} of={1} measured={false} skeleton />
          <Sheet plan={plan} orientation="landscape" page={1} of={1} measured={false} skeleton />
          {flows.map((flow) => (
            <div key={flow.key} className={`ws-col ws-col-${flow.orientation}`}>
              {flow.passageItem?.passage ? (
                <div
                  className="ws-passage ws-col-passage"
                  data-measure={flow.passageItem.passage.key}
                >
                  <PassageColumn item={flow.passageItem} />
                </div>
              ) : null}
              {flow.items.flatMap((item) =>
                item.blocks.map((block) => (
                  <div key={block.key} className="ws-blk" data-measure={block.key}>
                    <BlockView
                      block={block}
                      notation={item.notation}
                      orientation={flow.orientation}
                      segment={null}
                    />
                  </div>
                )),
              )}
            </div>
          ))}
        </div>
      </div>

      {pages ? null : <StatusView state="loading" />}

      {pages ? (
        <div
          key={`${plan.token}:${total}`}
          ref={attachSheets}
          className="ws-sheets"
          data-ws-sheets=""
          data-short-code={plan.shortCode}
          data-web-only={JSON.stringify(plan.webOnlyUnits)}
        >
          {pages.map((page, pageIndex) => {
            const number = pageIndex + 1;
            const passageItem = page.passageKey
              ? plan.items.find((item) => item.passage?.key === page.passageKey)
              : undefined;
            const blocks = page.placements.map((placement) => {
              const entry = index.get(placement.key);
              // Unreachable: unresolvedPlacement() fails the layout before pages are set.
              if (!entry) return null;
              return (
                <div key={`${placement.key}#${placement.segment?.index ?? 1}`} className="ws-blk">
                  <BlockView
                    block={entry.block}
                    notation={entry.item.notation}
                    orientation={page.orientation}
                    segment={placement.segment}
                  />
                </div>
              );
            });
            return (
              <Sheet
                key={number}
                plan={plan}
                orientation={page.orientation}
                page={number}
                of={total}
                measured
                overlay={overlayMap?.pages[pageIndex] ?? null}
              >
                {passageItem ? (
                  <div className="ws-split">
                    <article className="ws-passage">
                      <PassageColumn item={passageItem} />
                    </article>
                    <section className="ws-qs">{blocks}</section>
                  </div>
                ) : (
                  blocks
                )}
              </Sheet>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function PlannedSheets({ state, overlay }: { state: WorksheetExportStateT; overlay: boolean }) {
  const result = useMemo(() => buildWorksheetPlan(state), [state]);
  if (!result.ok) return <StatusView state="error" code="load_failed" detail={result.detail} />;
  // Keyed by export: navigating A → B → A with a cached query starts a fresh layout each time.
  return <Sheets key={state.export_token} plan={result.plan} overlay={overlay} />;
}

export default function WorksheetPrintPage({
  token,
  overlay = false,
}: {
  token: string;
  overlay?: boolean;
}) {
  const query = useQuery({
    queryKey: ['worksheet-export', token],
    queryFn: () => getWorksheetExport(token),
    // One render pass per page load: no background refetch may re-lay out a ready sheet.
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // The render-job hook lives as long as the page; it only reads the DOM when called.
  const attachRoot = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    window.__tlpWorksheetRegionMap = () => {
      if (document.documentElement.getAttribute(STATE_ATTR) !== 'ready') {
        throw new Error('worksheet is not ready');
      }
      const sheets = node.querySelector('[data-ws-sheets]');
      if (!sheets) throw new Error('worksheet sheets are not mounted');
      return measureRegionMap(sheets);
    };
    return () => {
      delete window.__tlpWorksheetRegionMap;
      clearDocState();
    };
  }, []);

  let body: ReactNode;
  if (query.isPending) {
    body = <StatusView state="loading" />;
  } else if (query.isError) {
    body = (
      <StatusView
        state="error"
        code={isExportNotFound(query.error) ? 'export_not_found' : 'load_failed'}
        detail={String(query.error)}
      />
    );
  } else {
    body = <PlannedSheets state={query.data} overlay={overlay} />;
  }

  return (
    <div ref={attachRoot} className="ws-root">
      {body}
    </div>
  );
}

// YUK-1528 — reads the region map off the rendered sheets. A pure read of the current DOM: every
// value is measured against its own page element and converted with that page's size_mm / box
// width, so it does not depend on device pixel ratio or zoom. The render job calls it through
// window.__tlpWorksheetRegionMap() right before page.pdf(); the ?overlay=1 view calls the same
// function to draw what was measured.
//
// DOM contract (written by WorksheetPrintPage):
//   [data-ws-sheets]   data-short-code, data-web-only (JSON string[])
//   [data-ws-page]     data-page, data-of, data-orientation, data-w-mm, data-h-mm, data-qr-payload
//   [data-ws-anchor]   tl | tr | bl | br; data-fill, data-stroke-mm
//   [data-ws-qr]       the QR box
//   [data-ws-region]   choice | writing; data-issuance, data-slot, data-units (JSON), data-segment,
//                      data-mark (writing)
//   [data-ws-option]   inside a choice region; data-option-id, data-order, data-label
// The overlay layer carries none of these attributes, so it is never measured.

import type {
  WorksheetAnchorT,
  WorksheetMmRectT,
  WorksheetPageMapT,
  WorksheetRegionMapArchiveBodyT,
  WorksheetRegionMarkT,
  WorksheetRegionT,
} from '@/capabilities/practice/api/worksheet-contracts';

export type WorksheetRegionMapDraft = Omit<WorksheetRegionMapArchiveBodyT, 'pdf_digest'>;

const round = (value: number) => Math.round(value * 1000) / 1000;

function attr(element: Element, name: string): string {
  const value = element.getAttribute(name);
  if (value == null) throw new Error(`worksheet measure: missing ${name}`);
  return value;
}

function readJsonStrings(element: Element, name: string): string[] {
  const parsed: unknown = JSON.parse(attr(element, name));
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`worksheet measure: ${name} is not a string list`);
  }
  return parsed as string[];
}

const MARKS: readonly WorksheetRegionMarkT[] = ['dots', 'squares', 'ruled'];

function measurePage(pageEl: HTMLElement): WorksheetPageMapT {
  const widthMm = Number(attr(pageEl, 'data-w-mm'));
  const heightMm = Number(attr(pageEl, 'data-h-mm'));
  const box = pageEl.getBoundingClientRect();
  if (box.width <= 0) throw new Error('worksheet measure: page has no width');
  const scale = widthMm / box.width;
  const rectOf = (element: Element): WorksheetMmRectT => {
    const r = element.getBoundingClientRect();
    return {
      x: round((r.left - box.left) * scale),
      y: round((r.top - box.top) * scale),
      w: round(r.width * scale),
      h: round(r.height * scale),
    };
  };

  const anchor = (corner: 'tl' | 'tr' | 'bl' | 'br'): WorksheetAnchorT => {
    const element = pageEl.querySelector(`[data-ws-anchor="${corner}"]`);
    if (!element) throw new Error(`worksheet measure: page lacks anchor ${corner}`);
    const rect = rectOf(element);
    const fill = attr(element, 'data-fill') === 'hollow' ? 'hollow' : 'solid';
    const stroke = element.getAttribute('data-stroke-mm');
    return {
      cx: round(rect.x + rect.w / 2),
      cy: round(rect.y + rect.h / 2),
      size: rect.w,
      fill,
      stroke_mm: fill === 'hollow' && stroke != null ? Number(stroke) : null,
    };
  };

  const qr = pageEl.querySelector('[data-ws-qr]');
  if (!qr) throw new Error('worksheet measure: page lacks the QR code');

  const regions: WorksheetRegionT[] = [];
  for (const element of pageEl.querySelectorAll('[data-ws-region]')) {
    const kind = attr(element, 'data-ws-region');
    const issuanceId = attr(element, 'data-issuance');
    const slotId = attr(element, 'data-slot');
    const segment = Number(attr(element, 'data-segment'));
    const mm = rectOf(element);
    for (const unitId of readJsonStrings(element, 'data-units')) {
      const regionId = `${issuanceId}/${unitId}/${segment}`;
      if (kind === 'choice') {
        const options = [...element.querySelectorAll('[data-ws-option]')].map((option) => ({
          option_id: attr(option, 'data-option-id'),
          order: Number(attr(option, 'data-order')),
          label: attr(option, 'data-label'),
          mm: rectOf(option),
        }));
        regions.push({
          region_id: regionId,
          kind: 'choice',
          issuance_id: issuanceId,
          slot_id: slotId,
          unit_id: unitId,
          mark: null,
          mm,
          segment_index: segment,
          options,
        });
      } else {
        const mark = attr(element, 'data-mark') as WorksheetRegionMarkT;
        if (!MARKS.includes(mark)) throw new Error(`worksheet measure: unknown mark ${mark}`);
        regions.push({
          region_id: regionId,
          kind: 'writing',
          issuance_id: issuanceId,
          slot_id: slotId,
          unit_id: unitId,
          mark,
          mm,
          segment_index: segment,
        });
      }
    }
  }

  return {
    page: Number(attr(pageEl, 'data-page')),
    of: Number(attr(pageEl, 'data-of')),
    orientation: attr(pageEl, 'data-orientation') === 'landscape' ? 'landscape' : 'portrait',
    size_mm: { w: widthMm, h: heightMm },
    qr: { payload: attr(pageEl, 'data-qr-payload'), mm: rectOf(qr) },
    anchors: { tl: anchor('tl'), tr: anchor('tr'), bl: anchor('bl'), br: anchor('br') },
    regions,
  };
}

/** Measure the region map of the sheets under `root` (the [data-ws-sheets] element). */
export function measureRegionMap(root: Element): WorksheetRegionMapDraft {
  const pages = [...root.querySelectorAll<HTMLElement>('[data-ws-page]')].map(measurePage);
  return {
    schema_version: 1,
    short_code: attr(root, 'data-short-code'),
    web_only_units: readJsonStrings(root, 'data-web-only'),
    pages,
  };
}

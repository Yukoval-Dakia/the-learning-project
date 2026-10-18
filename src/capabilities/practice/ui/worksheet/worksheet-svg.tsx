// YUK-1528 — vector pieces of the sheet: answer-area marks, corner anchors and the QR code. All
// are SVG in millimetre user units, so the PDF carries exact vector paths (layout doc §1).
import { encode } from 'uqr';

import { GRID_PITCH_MM, RULE_PITCH_MM } from './worksheet-geometry';
import type { WritingMark } from './worksheet-plan';

const DOT_FILL = '#b9b0a3';
const GRID_STROKE = '#e4ddd0';
const RULE_STROKE = '#ddd6c9';

const fmt = (value: number) => String(Math.round(value * 1000) / 1000);

function dotsPath(w: number, h: number): string {
  const r = 0.32;
  const parts: string[] = [];
  for (let y = GRID_PITCH_MM / 2; y < h; y += GRID_PITCH_MM) {
    for (let x = GRID_PITCH_MM / 2; x < w; x += GRID_PITCH_MM) {
      parts.push(
        `M${fmt(x - r)} ${fmt(y)}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`,
      );
    }
  }
  return parts.join('');
}

function gridPath(w: number, h: number): string {
  const cols = Math.floor(w / GRID_PITCH_MM);
  const rows = Math.floor(h / GRID_PITCH_MM);
  const right = cols * GRID_PITCH_MM;
  const bottom = rows * GRID_PITCH_MM;
  const parts: string[] = [];
  for (let c = 0; c <= cols; c += 1) parts.push(`M${fmt(c * GRID_PITCH_MM)} 0V${fmt(bottom)}`);
  for (let r = 0; r <= rows; r += 1) parts.push(`M0 ${fmt(r * GRID_PITCH_MM)}H${fmt(right)}`);
  return parts.join('');
}

function rulesPath(w: number, h: number): string {
  const parts: string[] = [];
  for (let y = RULE_PITCH_MM - 1; y < h; y += RULE_PITCH_MM) parts.push(`M0 ${fmt(y)}H${fmt(w)}`);
  return parts.join('');
}

/** The mark pattern filling a writing panel's inner box (w × h mm). */
export function PanelMark({ mark, w, h }: { mark: WritingMark; w: number; h: number }) {
  const box = { width: `${fmt(w)}mm`, height: `${fmt(h)}mm` };
  return (
    <svg
      className="ws-mk"
      viewBox={`0 0 ${fmt(w)} ${fmt(h)}`}
      style={box}
      aria-hidden="true"
      focusable="false"
    >
      {mark === 'dots' ? (
        <path d={dotsPath(w, h)} fill={DOT_FILL} />
      ) : mark === 'squares' ? (
        <path d={gridPath(w, h)} stroke={GRID_STROKE} strokeWidth={0.14} fill="none" />
      ) : (
        <path d={rulesPath(w, h)} stroke={RULE_STROKE} strokeWidth={0.18} fill="none" />
      )}
    </svg>
  );
}

const ANCHOR_SIZE_MM = 5;
const ANCHOR_STROKE_MM = 1.2;

/** Corner anchor (layout doc §2): 5mm square; TL/TR/BL solid, BR hollow with a 1.2mm stroke. */
export function Anchor({ corner }: { corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  const hollow = corner === 'br';
  const half = ANCHOR_STROKE_MM / 2;
  return (
    <svg
      className={`ws-an ws-an-${corner}`}
      viewBox={`0 0 ${ANCHOR_SIZE_MM} ${ANCHOR_SIZE_MM}`}
      data-ws-anchor={corner}
      data-fill={hollow ? 'hollow' : 'solid'}
      data-stroke-mm={hollow ? ANCHOR_STROKE_MM : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {hollow ? (
        <rect
          x={half}
          y={half}
          width={ANCHOR_SIZE_MM - ANCHOR_STROKE_MM}
          height={ANCHOR_SIZE_MM - ANCHOR_STROKE_MM}
          fill="none"
          stroke="#1f1e1d"
          strokeWidth={ANCHOR_STROKE_MM}
        />
      ) : (
        <rect width={ANCHOR_SIZE_MM} height={ANCHOR_SIZE_MM} fill="#1f1e1d" />
      )}
    </svg>
  );
}

/** QR modules as one path: each dark run in a row becomes a single rectangle. */
function qrPath(data: boolean[][]): string {
  const parts: string[] = [];
  data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      parts.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  });
  return parts.join('');
}

/**
 * The page identity code. Medium error correction keeps phone photos readable; a 2-module quiet
 * zone sits inside the 13mm box (the paper around it is blank too).
 */
export function WorksheetQr({ payload }: { payload: string }) {
  const qr = encode(payload, { ecc: 'M', border: 2 });
  return (
    <svg
      className="ws-qr"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      data-ws-qr=""
      aria-hidden="true"
      focusable="false"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qrPath(qr.data)} fill="#1f1e1d" />
    </svg>
  );
}

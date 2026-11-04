// Throwaway look prototype (YUK-1548 design checkpoint). Hand-written data only; no model involved.

/** Width estimate good enough for layout: CJK one em, Latin and digits a bit over half. */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += /[⺀-￯]/.test(ch) ? size : size * 0.58;
  return w;
}

/** Break text into lines no wider than maxWidth, at any CJK character or space. */
export function wrapText(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    if (line && textWidth(line + ch, size) > maxWidth) {
      lines.push(line);
      line = ch === ' ' ? '' : ch;
    } else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}

/** Rounded polyline through orthogonal points. */
export function roundedPath(points: Array<{ x: number; y: number }>, radius: number): string {
  const first = points[0];
  if (!first) return '';
  let d = `M${first.x},${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const p = points[i];
    const b = points[i + 1];
    if (!a || !p || !b) continue;
    const r = Math.min(radius, Math.hypot(p.x - a.x, p.y - a.y) / 2, Math.hypot(b.x - p.x, b.y - p.y) / 2);
    const ux = Math.sign(p.x - a.x);
    const uy = Math.sign(p.y - a.y);
    const vx = Math.sign(b.x - p.x);
    const vy = Math.sign(b.y - p.y);
    d += `L${p.x - ux * r},${p.y - uy * r}Q${p.x},${p.y} ${p.x + vx * r},${p.y + vy * r}`;
  }
  const last = points[points.length - 1];
  return last ? `${d}L${last.x},${last.y}` : d;
}

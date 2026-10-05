const LABEL_HORIZONTAL_PADDING = 16;
const LABEL_VERTICAL_PADDING = 10;
const LABEL_LINE_HEIGHT = 18;
const LABEL_MAX_LINES = 3;
const LABEL_MAX_CONTENT_WIDTH = 160;

export const MESH_LABEL_MAX_WIDTH = LABEL_MAX_CONTENT_WIDTH + LABEL_HORIZONTAL_PADDING;

function charWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint > 0xff ? 16 : 8;
}

function textWidth(text: string): number {
  return Array.from(text).reduce((width, char) => width + charWidth(char), 0);
}

function fitEllipsis(text: string): string {
  let result = text.trimEnd();
  while (result.length > 0 && textWidth(`${result}…`) > LABEL_MAX_CONTENT_WIDTH) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

export interface MeshLabelLayout {
  fullName: string;
  lines: string[];
  width: number;
  height: number;
  maxWidth: number;
  lineHeight: number;
  verticalPadding: number;
}

export function layoutMeshLabel(fullName: string): MeshLabelLayout {
  const lines: string[] = [];
  let current = '';
  for (const char of Array.from(fullName)) {
    if (char === ' ' && current.length === 0) continue;
    const candidate = `${current}${char}`;
    if (current.length > 0 && textWidth(candidate) > LABEL_MAX_CONTENT_WIDTH) {
      lines.push(current.trimEnd());
      current = char === ' ' ? '' : char;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current.trimEnd());
  if (lines.length === 0) lines.push('');

  if (lines.length > LABEL_MAX_LINES) {
    const visible = lines.slice(0, LABEL_MAX_LINES - 1);
    const tail = lines.slice(LABEL_MAX_LINES - 1).join(' ');
    visible.push(fitEllipsis(tail));
    lines.splice(0, lines.length, ...visible);
  }

  const widestLine = Math.max(...lines.map(textWidth));
  return {
    fullName,
    lines,
    width: Math.min(MESH_LABEL_MAX_WIDTH, Math.max(56, widestLine + LABEL_HORIZONTAL_PADDING)),
    height: lines.length * LABEL_LINE_HEIGHT + LABEL_VERTICAL_PADDING,
    maxWidth: MESH_LABEL_MAX_WIDTH,
    lineHeight: LABEL_LINE_HEIGHT,
    verticalPadding: LABEL_VERTICAL_PADDING,
  };
}

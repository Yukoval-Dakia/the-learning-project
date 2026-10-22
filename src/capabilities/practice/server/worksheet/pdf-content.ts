// worksheet PDF 页面内容层：流对象解压缩（FlateDecode）+ 有界
// 内容流解释器（q/Q 图形状态栈 + cm 全仿射复合）枚举上色形状。
// 由 jobs/worksheet_render.ts 迁出；只解释 Skia 输出子集，认不出的形态一律
// 抛错，不放行。

import { inflateSync } from 'node:zlib';

import { type ClassicXref, objectRegion } from './pdf-structure';

/** 读取流对象的 dict 与解压缩后的内容（FlateDecode 必需）。 */
export function streamObjectContent(
  text: string,
  xref: ClassicXref,
  objNum: number,
): { dict: string; content: string } {
  const region = objectRegion(text, xref, objNum, 'verify');
  const streamIdx = region.body.indexOf(' stream');
  if (streamIdx < 0) {
    throw new Error(`worksheet pdf verify: contents object ${objNum} is not a stream`);
  }
  const dict = region.body.slice(0, streamIdx);
  const lengthMatch = /\/Length\s+(\d+)/.exec(dict);
  if (lengthMatch == null) {
    throw new Error(`worksheet pdf verify: contents object ${objNum} has no /Length`);
  }
  if (!/\/Filter\s*\/FlateDecode/.test(dict)) {
    throw new Error(`worksheet pdf verify: contents object ${objNum} is not FlateDecode`);
  }
  const dataStart = region.start + streamIdx + ' stream'.length;
  // 'stream' 后跟 \r\n 或 \n（PDF 规范；Skia 恒为 \n）。
  const eol = text.startsWith('\r\n', dataStart) ? 2 : text.startsWith('\n', dataStart) ? 1 : -1;
  if (eol < 0) throw new Error('worksheet pdf verify: malformed stream keyword EOL');
  const compressed = Buffer.from(
    text.slice(dataStart + eol, dataStart + eol + Number(lengthMatch[1])),
    'latin1',
  );
  return { dict, content: inflateSync(compressed).toString('latin1') };
}

// ---- 有界内容流解释器（仅 Skia 输出子集；认不出的形态一律抛错，不放行） ----
// 全仿射矩阵 {a,b,c,d,e,f}（点变换 [ax+cy+e, bx+dy+f]）+ q/Q 图形状态栈 +
// 路径累积 + 上色算子。只解释确定语义：cm/q/Q/re/m/l/c/v/y/h/W/W*/n/rg/RG/
// g/G/k/K/w/BT 之外的着色与路径算子；其它一律「认识 op 但跳过其操作数」或
// 遇到二元/陌生构造直接抛错。

type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };
const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** outer ∘ inner：先 inner 后 outer 的点变换复合。 */
function compose(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

function apply(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export interface PaintedShape {
  kind: 'fill' | 'stroke' | 'fillstroke';
  /** 设备空间（PDF pt，页左下原点）包围盒 [minX, minY, maxX, maxY]。 */
  bbox: [number, number, number, number];
  fillRgb: [number, number, number] | null;
  strokeRgb: [number, number, number] | null;
  /** 有效描边宽（pt，已乘 CTM scale）。 */
  strokeWidthPt: number;
}

type PdfToken = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'other' };

/** 逐 token 扫 Skia 内容流：数字/算子/其它（name、括串、hex、数组、dict）。 */
function* contentTokens(s: string): Generator<PdfToken, void, void> {
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\0') {
      i += 1;
      continue;
    }
    if (ch === '%') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    if (ch === '(') {
      i += 1;
      let depth = 1;
      while (i < s.length && depth > 0) {
        const c = s[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        i += 1;
      }
      if (depth !== 0) throw new Error('worksheet pdf verify: unbalanced literal string');
      yield { t: 'other' };
      continue;
    }
    if (ch === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      if (end < 0) throw new Error('worksheet pdf verify: unterminated hex string');
      i = end + 1;
      yield { t: 'other' };
      continue;
    }
    if (ch === '/') {
      const m = /^\/[^\s<>[\](){}%/]+/.exec(s.slice(i));
      if (m == null) throw new Error('worksheet pdf verify: malformed name token');
      i += m[0].length;
      yield { t: 'other' };
      continue;
    }
    const num = /^-?\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (num != null && num[0].length > 0) {
      i += num[0].length;
      yield { t: 'num', v: Number(num[0]) };
      continue;
    }
    const op = /^[A-Za-z*'"!?]+/.exec(s.slice(i));
    if (op != null) {
      i += op[0].length;
      yield { t: 'op', v: op[0] };
      continue;
    }
    // [], <<, >>, 其它单字符 —— 当作非数字操作数吞掉。
    i += 1;
    yield { t: 'other' };
  }
}

/** 跳过 BI/ID/EI 内联图像块（内容是任意二进制，不进 tokenizer）。 */
function stripInlineImages(s: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const bi = s.indexOf('BI', cursor);
    if (bi < 0) return out + s.slice(cursor);
    const id = s.indexOf('ID', bi);
    const ei = id < 0 ? -1 : s.indexOf('EI', id + 2);
    if (id < 0 || ei < 0) {
      throw new Error('worksheet pdf verify: unterminated inline image (BI..EI)');
    }
    out += `${s.slice(cursor, bi)} `;
    cursor = ei + 2;
  }
}

/** 走完整条内容流，返回全部上色形状（设备 pt 坐标）。 */
export function interpretPageShapes(content: string): PaintedShape[] {
  const shapes: PaintedShape[] = [];
  let ctm = IDENTITY;
  const stack: Affine[] = [];
  let path: { x: number; y: number }[] = [];
  let fillRgb: [number, number, number] | null = null;
  let strokeRgb: [number, number, number] | null = null;
  let lineWidth = 1;
  const operands: number[] = [];

  const nums = (n: number, op: string): number[] => {
    if (operands.length < n) {
      throw new Error(`worksheet pdf verify: operator ${op} missing operands`);
    }
    return operands.splice(operands.length - n, n);
  };
  const ctmScale = (): number => {
    // |M| 的线性尺度（对角或近对角矩阵）。非对角近旋转/斜切时 |det| 仍是面积尺度。
    return Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c));
  };
  const paint = (kind: PaintedShape['kind']) => {
    if (path.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of path) {
      const q = apply(ctm, p.x, p.y);
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
    }
    shapes.push({
      kind,
      bbox: [minX, minY, maxX, maxY],
      fillRgb: fillRgb,
      strokeRgb: strokeRgb,
      strokeWidthPt: lineWidth * ctmScale(),
    });
    path = [];
  };

  for (const tok of contentTokens(stripInlineImages(content))) {
    if (tok.t === 'num') {
      operands.push(tok.v);
      continue;
    }
    if (tok.t === 'other') {
      // 非数字操作数 —— 保持与数字共栈，ops 需要时按位置取末尾数字。
      operands.length = 0; // 简化：名字/串/数组出现即视为新 op 序列开始
      continue;
    }
    const op = tok.v;
    switch (op) {
      case 'q':
        stack.push({ ...ctm });
        break;
      case 'Q':
        ctm = stack.pop() ?? IDENTITY;
        break;
      case 'cm': {
        const [a, b, c, d, e, f] = nums(6, op);
        ctm = compose(ctm, { a, b, c, d, e, f });
        break;
      }
      case 're': {
        const [x, y, w, h] = nums(4, op);
        path.push({ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h });
        break;
      }
      case 'm': {
        const [x, y] = nums(2, op);
        path.push({ x, y });
        break;
      }
      case 'l': {
        const [x, y] = nums(2, op);
        path.push({ x, y });
        break;
      }
      case 'c': {
        const p = nums(6, op);
        path.push({ x: p[0], y: p[1] }, { x: p[2], y: p[3] }, { x: p[4], y: p[5] });
        break;
      }
      case 'v':
      case 'y': {
        const p = nums(4, op);
        path.push({ x: p[0], y: p[1] }, { x: p[2], y: p[3] });
        break;
      }
      case 'h':
        break;
      case 'W':
      case 'W*':
        break;
      case 'n':
        path = [];
        break;
      case 'f':
      case 'f*':
      case 'F':
        paint('fill');
        break;
      case 'S':
        paint('stroke');
        break;
      case 's':
        paint('stroke');
        break;
      case 'B':
      case 'B*':
        paint('fillstroke');
        break;
      case 'b':
      case 'b*':
        paint('fillstroke');
        break;
      case 'rg': {
        const [r, g, b2] = nums(3, op);
        fillRgb = [r, g, b2];
        break;
      }
      case 'RG': {
        const [r, g, b2] = nums(3, op);
        strokeRgb = [r, g, b2];
        break;
      }
      case 'g': {
        const [v] = nums(1, op);
        fillRgb = [v, v, v];
        break;
      }
      case 'G': {
        const [v] = nums(1, op);
        strokeRgb = [v, v, v];
        break;
      }
      case 'k': {
        const p = nums(4, op);
        fillRgb = [
          Math.max(0, 1 - Math.min(1, p[0] + p[3])),
          Math.max(0, 1 - Math.min(1, p[1] + p[3])),
          Math.max(0, 1 - Math.min(1, p[2] + p[3])),
        ];
        break;
      }
      case 'K': {
        const p = nums(4, op);
        strokeRgb = [
          Math.max(0, 1 - Math.min(1, p[0] + p[3])),
          Math.max(0, 1 - Math.min(1, p[1] + p[3])),
          Math.max(0, 1 - Math.min(1, p[2] + p[3])),
        ];
        break;
      }
      case 'w': {
        const [v] = nums(1, op);
        lineWidth = v;
        break;
      }
      case 'd':
        operands.length = 0; // dash array + phase —— 已随数组 token 进栈，丢弃。
        break;
      default:
        // 认识的非几何 op（BT/ET/文本/字体/资源/Do/gs/sh/MP/BMC/EMC/Tr/Tw…）
        // 与陌生算子同样处理：清操作数栈，路径与 CTM 不受影响。
        operands.length = 0;
        break;
    }
  }
  return shapes;
}

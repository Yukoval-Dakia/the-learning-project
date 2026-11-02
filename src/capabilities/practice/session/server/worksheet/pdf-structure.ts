// worksheet PDF 字节结构层：classic xref/trailer 解析、对象定位、
// 顶层字典 token 扫描、引用对账、页树遍历（/Kids DFS + MediaBox/Rotate 继承）。
// 由 jobs/worksheet_render.ts 迁出（结构半区）：本模块只认字节与 PDF 规范
// 形状，不知道渲染/区域图契约；确定性坏文件一律 WorksheetRenderPermanentError。
// 该错误类型归此层所有 —— fidelity 与 worker 共用，避免 server ↔ jobs 环。

/** 永久失败：冻结输入（导出行/issuance/页面结构）决定重跑必然同果 —
 * 返回 failed_permanent 完结 job，不浪费重试（P3，attribution_followup 先例）。 */
export class WorksheetRenderPermanentError extends Error {}

// ---- classic xref / trailer / 对象定位 ----

/** 跳过当前行剩余部分（含行尾），返回下一行起点。 */
function skipLineEnd(text: string, cursor: number, what: string): number {
  const nl = text.indexOf('\n', cursor);
  if (nl < 0) throw new Error(`worksheet pdf canonicalize: unexpected EOF in ${what}`);
  return nl + 1;
}

export interface ClassicXref {
  objects: Map<number, { offset: number; gen: number }>;
  dictStart: number;
  dictEnd: number;
  trailerDict: string;
}

/** 末尾 startxref 锚定最后一个 classic xref 段，解析小节 → 对象偏移表与
 * trailer 字典（平衡 <<>> 扫描）。canonicalize 与渲染后 verify 共用；
 * Chromium 输出的确定性结构之外的形状一律抛错，不猜。 */
export function parseClassicXref(text: string, what: string): ClassicXref {
  const startxrefIdx = text.lastIndexOf('startxref');
  if (startxrefIdx < 0) throw new Error(`worksheet pdf ${what}: no startxref marker`);
  const tail = /^startxref\s+(\d+)\s+%%EOF/.exec(text.slice(startxrefIdx));
  if (tail == null) throw new Error(`worksheet pdf ${what}: malformed startxref/%%EOF tail`);
  const xrefStart = Number(tail[1]);
  if (text.slice(xrefStart, xrefStart + 4) !== 'xref') {
    throw new Error(
      `worksheet pdf ${what}: startxref does not point at a classic xref table ` +
        '(xref streams are unsupported — Chromium emits classic tables)',
    );
  }

  const objects = new Map<number, { offset: number; gen: number }>();
  let cursor = skipLineEnd(text, xrefStart + 'xref'.length, 'xref keyword');
  for (;;) {
    if (text.startsWith('trailer', cursor)) {
      cursor += 'trailer'.length;
      break;
    }
    const sub = /^(\d+) (\d+)[\r\n]+/.exec(text.slice(cursor, cursor + 40));
    if (sub == null) {
      throw new Error(`worksheet pdf ${what}: malformed xref subsection header`);
    }
    cursor += sub[0].length;
    const first = Number(sub[1]);
    const count = Number(sub[2]);
    for (let i = 0; i < count; i += 1) {
      const entry = /^(\d{10}) (\d{5}) ([nf])/.exec(text.slice(cursor, cursor + 20));
      if (entry == null) {
        throw new Error(`worksheet pdf ${what}: malformed xref entry for object ${first + i}`);
      }
      if (entry[3] === 'n') {
        objects.set(first + i, { offset: Number(entry[1]), gen: Number(entry[2]) });
      }
      cursor = skipLineEnd(text, cursor, `xref entry ${first + i}`);
    }
  }

  const dictStart = text.indexOf('<<', cursor);
  if (dictStart < 0) throw new Error(`worksheet pdf ${what}: trailer has no dictionary`);
  let depth = 0;
  let dictEnd = -1;
  for (let i = dictStart; i < text.length - 1; i += 1) {
    if (text[i] === '<' && text[i + 1] === '<') {
      depth += 1;
      i += 1;
      continue;
    }
    if (text[i] === '>' && text[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) {
        dictEnd = i + 1; // 切片终点：'>>' 之后
        break;
      }
    }
  }
  if (dictEnd < 0) throw new Error(`worksheet pdf ${what}: unbalanced trailer dictionary`);
  const trailerDict = text.slice(dictStart, dictEnd);
  if (/\/Prev\s+\d/.test(trailerDict)) {
    throw new Error(`worksheet pdf ${what}: incremental /Prev trailer chain unsupported`);
  }
  return { objects, dictStart, dictEnd, trailerDict };
}

/** 按 xref 偏移取对象体（`N G obj` … `endobj` 之间），offset 校验不猜。 */
export function objectRegion(
  text: string,
  xref: ClassicXref,
  objNum: number,
  what: string,
): { start: number; end: number; body: string } {
  const entry = xref.objects.get(objNum);
  if (entry == null) {
    throw new Error(`worksheet pdf ${what}: object ${objNum} has no xref entry`);
  }
  if (!text.startsWith(`${objNum} ${entry.gen} obj`, entry.offset)) {
    throw new Error(`worksheet pdf ${what}: xref offset for object ${objNum} does not point at it`);
  }
  const end = text.indexOf('endobj', entry.offset);
  if (end < 0) throw new Error(`worksheet pdf ${what}: object ${objNum} has no endobj bound`);
  return { start: entry.offset, end, body: text.slice(entry.offset, end) };
}

// ---- 页树遍历（/Kids 深度优先序，MediaBox/Rotate 按规范继承） ----
// Skia 的页树不是恒定的单根：实测 9 页卷子产 root /Pages Kids [中间 /Pages
// 节点, 末页 /Page]，中间节点再挂 8 个叶子。页序与页数的真相是 trailer
// Root → catalog /Pages → /Kids 深度优先序，不是"全文件唯一的 /Pages
// 对象"。每个 /Pages 节点的 /Count 与其子树实际解析出的叶子数逐项对账；
// 重复/环/共享引用、悬空/旧代引用、声明而非法的可继承属性、非 90 倍数或
// 非 0 有效 /Rotate（/Rotate 未声明沿祖先链继承、全无声明按 0；锚点几何
// 定义在未旋转页面坐标上，旋转页在渲染契约之外）一律诚实失败，不跳过、
// 不猜。visited 集合在整个遍历保留，先 has 后 add —— 重复叶子、共享子树、
// 环都过不了。

// -- 字典 token 扫描：属性按真实顶层 key 取值，字符串/嵌套结构/流里偶然
// 撞中的同名字样不冒充属性；三个 *SpanEnd 互递归 --

/** 跳过空白与 %注释，返回第一个实质字符位。 */
function skipWsAndComments(text: string, i: number): number {
  let j = i;
  for (;;) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0') {
      j += 1;
      continue;
    }
    if (c === '%') {
      const nl = text.indexOf('\n', j);
      j = nl < 0 ? text.length : nl + 1;
      continue;
    }
    return j;
  }
}

/** i 指向 '('，返回配对 ')' 后一位（处理 \转义与合法嵌套）。 */
function literalStringEnd(text: string, i: number, what: string): number {
  let j = i + 1;
  let depth = 1;
  while (j < text.length && depth > 0) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    j += 1;
  }
  if (depth !== 0) {
    throw new Error(`worksheet pdf verify: unbalanced literal string in ${what}`);
  }
  return j;
}

/** i 指向 '<<'，返回配对 '>>' 后一位；不平衡即抛。 */
function dictSpanEnd(text: string, i: number, what: string): number {
  let j = i + 2;
  for (;;) {
    j = skipWsAndComments(text, j);
    if (j >= text.length) throw new Error(`worksheet pdf verify: unbalanced << >> in ${what}`);
    if (text.startsWith('>>', j)) return j + 2;
    j = valueTokenEnd(text, j, what);
  }
}

/** i 指向 '['，返回配对 ']' 后一位；不平衡即抛。 */
function arraySpanEnd(text: string, i: number, what: string): number {
  let j = i + 1;
  for (;;) {
    j = skipWsAndComments(text, j);
    if (j >= text.length) throw new Error(`worksheet pdf verify: unbalanced [ ] in ${what}`);
    if (text[j] === ']') return j + 1;
    j = valueTokenEnd(text, j, what);
  }
}

/** i 指向任意值 token 起点，返回其结束位：括串、hex 串、<<dict>>、[array]
 * 整体跳过；/名字、数字、裸 atom 取到下一个分隔符。 */
function valueTokenEnd(text: string, i: number, what: string): number {
  const c = text[i];
  if (c === '(') return literalStringEnd(text, i, what);
  if (c === '<' && text[i + 1] === '<') return dictSpanEnd(text, i, what);
  if (c === '<') {
    const e = text.indexOf('>', i + 1);
    if (e < 0) throw new Error(`worksheet pdf verify: unterminated hex string in ${what}`);
    return e + 1;
  }
  if (c === '[') return arraySpanEnd(text, i, what);
  const m = /^[^\s<>[\](){}%]+/.exec(text.slice(i));
  if (m == null) throw new Error(`worksheet pdf verify: bad token in ${what}`);
  return i + m[0].length;
}

/** 对象体（或裸 `<<...>>` 的 trailer 字典）→ 顶层 key 原始值文本。
 * 'N G obj' 头之后必须紧跟 <<（数组/裸值对象直接拒）；值取完整 token：
 * `N G R` 引用含三个 atom，数组/嵌套 dict/括串含定界符。重复 key = 坏文件。 */
function topLevelDictEntries(objectBody: string, what: string): Map<string, string> {
  const objHeader = /^\s*\d+\s+\d+\s+obj\b/.exec(objectBody);
  const dictStart = skipWsAndComments(objectBody, objHeader == null ? 0 : objHeader[0].length);
  if (!objectBody.startsWith('<<', dictStart)) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} is not a dictionary object`,
    );
  }
  const inner = objectBody.slice(dictStart + 2, dictSpanEnd(objectBody, dictStart, what) - 2);
  const entries = new Map<string, string>();
  let j = 0;
  for (;;) {
    j = skipWsAndComments(inner, j);
    if (j >= inner.length) break;
    const key = /^\/([^\s<>[\](){}%/]+)/.exec(inner.slice(j));
    if (key == null) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: ${what} has a non-name dict entry`,
      );
    }
    if (entries.has(key[1])) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: ${what} declares /${key[1]} twice`,
      );
    }
    const vStart = skipWsAndComments(inner, j + key[0].length);
    let vEnd = valueTokenEnd(inner, vStart, what);
    // N G R 是三个 atom 的单值：首 token 是裸整数且后跟 `G R` 时整段算值。
    if (/^\d+$/.test(inner.slice(vStart, vEnd))) {
      const tail = /^\s+\d+\s+R\b/.exec(inner.slice(vEnd));
      if (tail != null) vEnd += tail[0].length;
    }
    entries.set(key[1], inner.slice(vStart, vEnd).trim());
    j = vEnd;
  }
  return entries;
}

/** 引用目标一致性：对象须在 xref 且 ref 声明的 gen 与 xref 记录相同 ——
 * 指向旧代的悬空引用是坏文件，不猜。 */
function checkRefTarget(xref: ClassicXref, objNum: number, gen: number, what: string): void {
  const entry = xref.objects.get(objNum);
  if (entry == null) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} — object ${objNum} ${gen} R is not in the xref table`,
    );
  }
  if (entry.gen !== gen) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} — object ${objNum} ${gen} R is a stale generation ` +
        `(xref records gen ${entry.gen})`,
    );
  }
}

const PDF_INTEGER = /^[+-]?\d+$/;
const PDF_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const PDF_REF = /^(\d+)\s+(\d+)\s+R$/;

/** 顶层 /Key N G R：缺失或值不是完整单 ref → 抛错；ref gen 对账走
 * checkRefTarget。 */
export function requiredIndirectRef(
  entries: Map<string, string>,
  key: string,
  xref: ClassicXref,
  what: string,
): number {
  const raw = entries.get(key);
  const ref = raw == null ? null : PDF_REF.exec(raw);
  if (ref == null) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} has no single /${key} indirect ref`,
    );
  }
  const objNum = Number(ref[1]);
  checkRefTarget(xref, objNum, Number(ref[2]), `${what} /${key}`);
  return objNum;
}

/** 顶层 /MediaBox —— 页树可继承属性（规范）。只有本节点字典确实
 * 没有声明才返回 null 走继承；声明了就必须是直接 [n n n n] —— 间接引用、
 * malformed、数组长度不对一律 PermanentError，不允许静默落回继承值。
 * 退化盒同样是坏文件。 */
function declaredMediaBox(
  entries: Map<string, string>,
  what: string,
): [number, number, number, number] | null {
  const raw = entries.get('MediaBox');
  if (raw == null) return null;
  const arr = /^\[([\s\S]*)\]$/.exec(raw);
  const parts =
    arr?.[1]
      .trim()
      .split(/\s+/)
      .filter((p) => p !== '') ?? null;
  if (
    arr == null ||
    parts == null ||
    parts.length !== 4 ||
    parts.some((p) => !PDF_NUMBER.test(p))
  ) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} declares /MediaBox ${raw} ` +
        '— only a direct four-number array is supported',
    );
  }
  const box = [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3])] as [
    number,
    number,
    number,
    number,
  ];
  if (!(box[2] > box[0] && box[3] > box[1])) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} has a degenerate /MediaBox [${box.join(' ')}]`,
    );
  }
  return box;
}

/** 顶层 /Rotate —— 可继承属性；未声明返回 null（有效值由祖先决，全无
 * 声明按 0）。声明了就必须是完整整数 literal —— `0.5`、`N 0 R`、其它形态
 * 一律 PermanentError；规范只允许 90 的倍数，归一到 [0,360)。 */
function declaredRotate(entries: Map<string, string>, what: string): number | null {
  const raw = entries.get('Rotate');
  if (raw == null) return null;
  if (!PDF_INTEGER.test(raw)) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} declares /Rotate ${raw} — only a direct integer is supported`,
    );
  }
  const deg = Number(raw);
  if (deg % 90 !== 0) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} /Rotate ${deg} is not a multiple of 90`,
    );
  }
  return ((deg % 360) + 360) % 360;
}

/** 顶层 /Count —— /Pages 节点必需的直接整数 ≥0。 */
function declaredCount(entries: Map<string, string>, what: string): number {
  const raw = entries.get('Count');
  if (raw == null || !PDF_INTEGER.test(raw)) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} (/Pages) has no integer /Count`,
    );
  }
  const count = Number(raw);
  if (count < 0) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} (/Pages) declares negative /Count ${count}`,
    );
  }
  return count;
}

/** 顶层 /Kids —— 必须是直接数组且只含 `N G R` 引用；间接引用数组、嵌套
 * 数组/名字/游离 token、悬空或旧代引用 = 坏文件。 */
function declaredKidsRefs(entries: Map<string, string>, xref: ClassicXref, what: string): number[] {
  const raw = entries.get('Kids');
  const arr = raw == null ? null : /^\[([\s\S]*)\]$/.exec(raw);
  if (arr == null) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} (/Pages) has no direct /Kids array`,
    );
  }
  const refs: number[] = [];
  for (const m of arr[1].matchAll(/(\d+)\s+(\d+)\s+R\b/g)) {
    checkRefTarget(xref, Number(m[1]), Number(m[2]), `${what} /Kids entry`);
    refs.push(Number(m[1]));
  }
  if (arr[1].replace(/\d+\s+\d+\s+R\b/g, ' ').trim() !== '') {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${what} /Kids holds non-reference tokens`,
    );
  }
  return refs;
}

export interface PageTreeLeaf {
  objNum: number;
  /** 页对象顶层字典（/Contents 从这里再读）。 */
  entries: Map<string, string>;
  /** 有效 /MediaBox（本页或最近祖先，原点已校验 [0 0]）。 */
  mediaBox: [number, number, number, number];
}

/** trailer /Root → catalog /Pages → /Kids 深度优先序的叶子 /Page 序列
 * （即 PDF 页序），任意深度 —— 显式栈 DFS，不靠 JS 调用栈也不设人为层数
 * 上限。'enter' 帧携带继承上下文（/MediaBox、/Rotate 沿祖先链解析）；kids
 * 逆序压栈，弹出即声明序；'exit' 帧在子树走完后把节点声明 /Count 与其
 * 实际叶子数对账。visited 先 has 后 add：重复叶子、共享子树、环一律拒绝。 */
export function collectPageTreeLeaves(text: string, xref: ClassicXref): PageTreeLeaf[] {
  const trailerEntries = topLevelDictEntries(xref.trailerDict, 'trailer');
  const catalogNum = requiredIndirectRef(trailerEntries, 'Root', xref, 'trailer');
  const catalogEntries = topLevelDictEntries(
    objectRegion(text, xref, catalogNum, 'verify').body,
    `catalog ${catalogNum}`,
  );
  if (catalogEntries.get('Type') !== '/Catalog') {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: trailer /Root ${catalogNum} is not a /Type /Catalog`,
    );
  }
  const rootNum = requiredIndirectRef(catalogEntries, 'Pages', xref, `catalog ${catalogNum}`);

  const leaves: PageTreeLeaf[] = [];
  const visited = new Set<number>();
  const stack: Array<
    | {
        kind: 'enter';
        objNum: number;
        inheritedBox: [number, number, number, number] | null;
        inheritedRotate: number | null;
      }
    | { kind: 'exit'; objNum: number; declared: number; before: number }
  > = [{ kind: 'enter', objNum: rootNum, inheritedBox: null, inheritedRotate: null }];

  for (;;) {
    const frame = stack.pop();
    if (frame == null) break;
    if (frame.kind === 'exit') {
      const actual = leaves.length - frame.before;
      if (actual !== frame.declared) {
        throw new WorksheetRenderPermanentError(
          `worksheet pdf verify: page-tree node ${frame.objNum} (/Pages) declares ` +
            `/Count ${frame.declared} but resolves to ${actual} leaf page(s)`,
        );
      }
      continue;
    }
    const { objNum } = frame;
    if (visited.has(objNum)) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: page tree revisits object ${objNum} (cycle, shared subtree, or duplicate leaf)`,
      );
    }
    visited.add(objNum);
    const what = `page-tree node ${objNum}`;
    const entries = topLevelDictEntries(objectRegion(text, xref, objNum, 'verify').body, what);
    const mediaBox = declaredMediaBox(entries, what) ?? frame.inheritedBox;
    const rotate = declaredRotate(entries, what) ?? frame.inheritedRotate;
    const type = entries.get('Type');
    if (type === '/Pages') {
      stack.push({
        kind: 'exit',
        objNum,
        declared: declaredCount(entries, what),
        before: leaves.length,
      });
      const kids = declaredKidsRefs(entries, xref, what);
      for (let k = kids.length - 1; k >= 0; k -= 1) {
        stack.push({
          kind: 'enter',
          objNum: kids[k],
          inheritedBox: mediaBox,
          inheritedRotate: rotate,
        });
      }
      continue;
    }
    if (type === '/Page') {
      if (entries.has('Kids')) {
        throw new WorksheetRenderPermanentError(
          `worksheet pdf verify: ${what} is a /Page carrying /Kids`,
        );
      }
      if (mediaBox == null) {
        throw new WorksheetRenderPermanentError(
          `worksheet pdf verify: ${what} has no /MediaBox on itself or any ancestor`,
        );
      }
      // 渲染契约是零原点页：非零 llx/lly 会平移物理纸边而锚点坐标不变 ——
      // 拒绝，不把丢原点的宽高对账当物理锚点验证。
      if (mediaBox[0] !== 0 || mediaBox[1] !== 0) {
        throw new WorksheetRenderPermanentError(
          `worksheet pdf verify: ${what} effective /MediaBox origin ` +
            `[${mediaBox[0]} ${mediaBox[1]}] is not [0 0] — a shifted origin moves ` +
            'physical page edges and is outside the render contract',
        );
      }
      const effectiveRotate = rotate ?? 0;
      if (effectiveRotate !== 0) {
        throw new WorksheetRenderPermanentError(
          `worksheet pdf verify: ${what} effective /Rotate ${effectiveRotate} — rotated ` +
            'pages shift anchor geometry and are outside the render contract',
        );
      }
      leaves.push({ objNum, entries, mediaBox });
      continue;
    }
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: page-tree kid ${objNum} is neither /Type /Page ` +
        `nor /Type /Pages (declared ${type ?? '<none>'})`,
    );
  }
  return leaves;
}

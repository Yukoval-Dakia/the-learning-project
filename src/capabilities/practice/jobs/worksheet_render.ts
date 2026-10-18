// YUK-1529 — worksheet_render job：服务端无头 Chromium 渲染作答卷。
//
// 流程（与 UI 线验证过的渲染配方逐字一致）：
//   1. playwright-core 开 /print/worksheet/<token>（Asia/Tokyo context，
//      emulateMedia print 在导航之前 —— 不设 print media 隐藏测量区没有
//      布局，量出的区域图是错的）；
//   2. 等 <html data-worksheet-state="ready">；error/layout_overflow 如实失败；
//   3. 同一页面调 window.__tlpWorksheetRegionMap() 拿区域图；
//   4. 同一页面 page.pdf()；
//   5. 对象级 canonicalize（抹掉 Chromium 每次渲染都打上的墙钟元数据）→ sha256
//      → pdf_digest；
//   6. PDF 写 R2（content-addressed key，重跑安全）；
//   7. 走 #1773 既有 archiveWorksheetRegionMap write-once 存档：
//      同图同 digest ⇒ existing，异 ⇒ 冲突如实抛出。
//
// 网络边界（R1 P1-2）：
//   - context.route('**/*') 对同源请求走 route.fetch({ maxRedirects: 0 }) —
//     Playwright 自动跟随 3xx 时不会再进 route handler，同源页面 302 到外站
//     会绕过 allowlist；拿到原始 3xx 后显式裁决 Location，离站即 abort 并记录；
//   - context.routeWebSocket 关掉一切非本站 socket 并记录（vite HMR 等同站 ws
//     照常双向透传）；
//   - serviceWorkers: 'block' —— SW 可持缓存绕过 route 拦截，一律禁掉；
//   - init script 只在 location.origin === 受信 origin 时才写 internal token；
//   - render origin 只许内部宿主（loopback 或 compose 'app' 服务名），job 数据
//     里也不接受任意 URL。
//   被 abort 的 URL 全部进 job 结果的 aborted_urls —— 泄漏可见。
//
// 挂死保护（R1 P1-4）：整段浏览器过程有一个总 deadline（远小于 agent 档 2h
// expire），并监听 pg-boss job.signal；任一触发即主动 browser.close()（挂起的
// page 操作随之 reject），job 诚实失败且不存档；finally 兜底关 browser。
//
// 不存半档：任何一步失败都不存档；blob 已写但存档失败时错误信息带留下的
// content-addressed key。
//
// 本 job 不调任何模型，零成本。Chromium 只在 worker 镜像（Dockerfile worker
// stage），app 镜像不变。

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { Job } from 'pg-boss';
import type { Browser as ChromiumBrowser, Page as ChromiumPage } from 'playwright-core';

import type { WorksheetRegionMapArchiveBodyT } from '@/capabilities/practice/api/worksheet-contracts';
import { WorksheetRegionMapArchiveBody } from '@/capabilities/practice/api/worksheet-contracts';
import {
  type ArchiveRegionMapResult,
  archiveWorksheetRegionMap,
} from '@/capabilities/practice/server/worksheet/export-store';
import {
  putWorksheetExportPdf,
  worksheetPdfBlobKey,
} from '@/capabilities/practice/server/worksheet/pdf-store';
import type { Db } from '@/db/client';

// src/ui/lib/api.ts TOKEN_STORAGE_KEY —— 打印页的 /api 调用从这里读 token。
const TOKEN_STORAGE_KEY = 'loom_internal_token';

// R1/CI-1：tests/dbos-* 等 harness 用自己的 --external 清单 esbuild 打 worker
// entry —— 静态 import 会把 chromium-bidi 内部文件拖进那些 bundle 里
// `Could not resolve`。运行期 lazy require 让所有 bundler 都看不到它；
// dist/worker.cjs 在 worker 镜像里从 flat COPY 的 node_modules 解析。
// 锚点用 cwd/package.json（文件不必存在，只取目录）：worker 容器 WORKDIR=/app
// → /app/node_modules；dev/tsx cwd=repo root → ./node_modules。不用
// import.meta.url —— esbuild cjs 输出把它 shim 成空对象；不用 __filename ——
// "type": "module" 下 tsx/vitest 里没有这个名字。
type PlaywrightCore = typeof import('playwright-core');
const requireFromHere = createRequire(join(process.cwd(), 'package.json'));
let playwrightCore: PlaywrightCore | null = null;
function loadPlaywrightCore(): PlaywrightCore {
  playwrightCore ??= requireFromHere('playwright-core') as PlaywrightCore;
  return playwrightCore;
}

const NAV_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 120_000;
/** 整段浏览器 pass 的总 deadline：3 分钟 —— 远低于 agent 档 2h 队列过期，
 * 真实渲染在秒级，超此上限只能是挂死；触发即关 browser 并诚实失败。 */
const RENDER_DEADLINE_MS = 180_000;

// ---------- 渲染 origin 只允许内部宿主（R1 P1-2） ----------

/** loopback 与 compose 内部服务名；不接受来自 job 数据或 env 的任意外站。 */
const ALLOWED_RENDER_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'app']);

function resolveRenderOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorksheetRenderPermanentError(
      `worksheet_render: render origin '${raw}' is not a URL`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WorksheetRenderPermanentError(
      `worksheet_render: render origin '${raw}' must be http(s)`,
    );
  }
  if (!ALLOWED_RENDER_HOSTNAMES.has(url.hostname)) {
    throw new WorksheetRenderPermanentError(
      `worksheet_render: render origin host '${url.hostname}' is not an internal host ` +
        '(allowed: loopback or the compose "app" service)',
    );
  }
  return url.origin;
}

// ---------- 对象级 PDF canonicalize（R1 P1-3） ----------
//
// Chromium（Skia/PDF）每次渲染都嵌入墙钟 CreationDate/ModDate（Info 对象），
// 部分版本还在 trailer 放随机 /ID —— 同一份 DOM 出两份不同字节，write-once
// 存档会把重跑误判成冲突。
//
// 这里做**对象感知**的同长度归一（绝不全文正则扫二进制流）：
//   a) 末尾 startxref → xref 表 → trailer 字典（平衡 <<>> 扫描），只改 trailer
//      里的 /ID [<hex><hex>]（十六进制位同长度置 0）；有 /Prev 增量链直接抛错；
//   b) trailer /Info N 0 R 指到的对象（按其 xref 偏移定位、endobj 截界）里，
//      只抹 /CreationDate (...) 与 /ModDate (...) 的括串内容（同长度定值）。
// 之后断言：输出长度 === 输入长度；xref 每个 n 条目偏移仍指向 `N G obj`。
// 任何一步不满足都抛错 —— 坏文件诚实失败，不猜、不放宽。

const CANONICAL_PDF_DATE = 'D:19700101000000Z';

/** 跳过当前行剩余部分（含行尾），返回下一行起点。 */
function skipLineEnd(text: string, cursor: number, what: string): number {
  const nl = text.indexOf('\n', cursor);
  if (nl < 0) throw new Error(`worksheet pdf canonicalize: unexpected EOF in ${what}`);
  return nl + 1;
}

interface ClassicXref {
  objects: Map<number, { offset: number; gen: number }>;
  dictStart: number;
  dictEnd: number;
  trailerDict: string;
}

/** 末尾 startxref 锚定最后一个 classic xref 段，解析小节 → 对象偏移表与
 * trailer 字典（平衡 <<>> 扫描）。canonicalize 与渲染后 verify 共用；
 * Chromium 输出的确定性结构之外的形状一律抛错，不猜。 */
function parseClassicXref(text: string, what: string): ClassicXref {
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
function objectRegion(
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

export function canonicalizeWorksheetPdf(pdf: Buffer): Buffer {
  const text = pdf.toString('latin1');
  const xref = parseClassicXref(text, 'canonicalize');

  const replacements: Array<{ at: number; length: number; text: string }> = [];
  const splice = (regionStart: number, regionEnd: number, rewrite: (s: string) => string) => {
    const region = text.slice(regionStart, regionEnd);
    const out = rewrite(region);
    if (out.length !== region.length) {
      throw new Error('worksheet pdf canonicalize: a rewrite changed byte length');
    }
    if (out !== region) replacements.push({ at: regionStart, length: region.length, text: out });
  };

  // (a) trailer /ID [<hex><hex>]：十六进制位同长度置 0。
  splice(xref.dictStart, xref.dictEnd, (region) =>
    region.replace(
      /\/ID\s*\[\s*<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>\s*\]/g,
      (_match, first: string, second: string) =>
        `/ID [<${'0'.repeat(first.length)}><${'0'.repeat(second.length)}>]`,
    ),
  );

  // (b) trailer /Info N 0 R → Info 对象（xref 偏移定位，endobj 截界）。
  const infoRef = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(xref.trailerDict);
  if (infoRef != null) {
    const info = objectRegion(text, xref, Number(infoRef[1]), 'canonicalize');
    splice(info.start, info.end, (region) =>
      region.replace(
        /\/(CreationDate|ModDate)\s*\(([^()]*)\)/g,
        (_match, key: string, value: string) => {
          const inner =
            value.length >= CANONICAL_PDF_DATE.length
              ? CANONICAL_PDF_DATE + ' '.repeat(value.length - CANONICAL_PDF_DATE.length)
              : ' '.repeat(value.length);
          return `/${key} (${inner})`;
        },
      ),
    );
  }

  // --- 应用替换（顺序无关，偏移不漂移——全部同长度） ---
  let out = text;
  for (const replacement of replacements.sort((a, b) => b.at - a.at)) {
    out =
      out.slice(0, replacement.at) +
      replacement.text +
      out.slice(replacement.at + replacement.length);
  }

  // --- 断言：长度不变 + xref 每个 n 条目仍指向 `N G obj` ---
  if (out.length !== text.length) {
    throw new Error('worksheet pdf canonicalize: output length drifted');
  }
  for (const [objNum, entry] of xref.objects) {
    if (!out.startsWith(`${objNum} ${entry.gen} obj`, entry.offset)) {
      throw new Error(
        `worksheet pdf canonicalize: xref offset for object ${objNum} no longer points at it`,
      );
    }
  }
  return Buffer.from(out, 'latin1');
}

// ---------- 渲染产物强制校验（Grok QA P1-1：write-once 存档，错了就是永久脏数据） ----------
//
// 起因：page.pdf() 时隐藏测量区 .ws-stage-host 还在 DOM —— 里面的 297mm 横向
// 样张把 ≥3 页的卷面整体 shrink-to-fit 到 ~0.73，四角定位点全偏，但区域图
// 仍按 1:1 mm 存档（write-once 无法补救）。job 侧修复：先取区域图 → 移除
// .ws-stage-host → 再 page.pdf()；然后对产物字节做下述硬校验，任何一项不过
// 即判渲染失败：不写 blob、不存档。
//
// 校验项：
//   1. PDF 页数 === 区域图页数（/Type /Page 对象数与 /Count 双证）。
//   2. 每页 MediaBox = A4：portrait 595.28×841.89pt、landscape 841.89×595.28pt
//      （方向以区域图为准），±1pt。
//   3. **实测四个画出来的定位点**：有界解释器走页面内容流 —— q/Q 图形状态
//      栈 + cm 复合全仿射（scale、平移都在内，不猜前缀）——收集 fill/stroke
//      上色的路径，按 producer contract（worksheet-svg.tsx Anchor：#1f1e1d
//      的 5mm 实心方块 / BR 1.2mm 描边 3.8mm 空心方块）找出四角锚点，量出
//      它们在该页 PDF 里的真实中心与尺寸，与区域图登记的 mm 位置逐项对账
//      （±0.5mm）。shrink/平移/DPI 变化都等价地体现在画出来坐标上 —— 这是
//      对 PDF↔map 一致性的直接证明，不依赖任何流结构假设。找不齐、形态对
//      不上、解不出 → 一律诚实失败，不放行。
//   实测值全部进 job 结果 verification 字段留证。

/** 永久失败：冻结输入（导出行/issuance/页面结构）决定重跑必然同果 —
 * 返回 failed_permanent 完结 job，不浪费重试（P3，attribution_followup 先例）。 */
export class WorksheetRenderPermanentError extends Error {}

const A4_PORTRAIT_PT = { w: 595.28, h: 841.89 } as const;
const MEDIA_BOX_TOLERANCE_PT = 1;
const PT_PER_MM = 72 / 25.4;
const ANCHOR_TOLERANCE_MM = 0.5;

export interface WorksheetAnchorMeasurement {
  corner: 'tl' | 'tr' | 'bl' | 'br';
  /** PDF 实测中心（页左上角为原点的 mm）。 */
  center_mm: [number, number];
  /** 与区域图登记位置的最大坐标偏差（mm）。 */
  error_mm: number;
  /** PDF 实测可视边长（mm；hollow 按 path bbox + 描边宽）。 */
  size_mm: number;
  kind: 'solid' | 'hollow';
}

export interface WorksheetPageVerification {
  page: number;
  mediabox_pt: [number, number];
  orientation: string;
  anchors: WorksheetAnchorMeasurement[];
}

export interface WorksheetPdfVerification {
  page_count_pdf: number;
  page_count_map: number;
  pages: WorksheetPageVerification[];
}

/** 读取流对象的 dict 与解压缩后的内容（FlateDecode 必需）。 */
function streamObjectContent(
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
//
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

interface PaintedShape {
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
function interpretPageShapes(content: string): PaintedShape[] {
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

// ---- Anchor producer contract（ui/worksheet/worksheet-svg.tsx + worksheet-print.css） ----
// <svg viewBox="0 0 5 5">：TL/TR/BL = <rect 5×5 fill #1f1e1d>（实心），
// BR = <rect 0.6 0.6 3.8 3.8 stroke #1f1e1d strokeWidth 1.2>（空心）。
// 每个角锚 DOM 位置 6mm from edge，中心 8.5mm —— 区域图 cx/cy 即其 mm 中心。

const ANCHOR_INK: [number, number, number] = [0.1216, 0.1176, 0.1137]; // #1f1e1d
const ANCHOR_INK_TOLERANCE = 0.04;
const ANCHOR_SIZE_PT = 5 * PT_PER_MM; // 14.173pt —— 实心 bbox / 空心外缘
const ANCHOR_STROKE_INNER_PT = (5 - 1.2) * PT_PER_MM; // 10.77pt —— 空心 path bbox
const ANCHOR_STROKE_PT = 1.2 * PT_PER_MM; // 3.40pt
const ANCHOR_SIZE_TOLERANCE_PT = 2; // 名义 5mm ±~0.7mm
const ANCHOR_CENTER_TOLERANCE_PT = ANCHOR_TOLERANCE_MM * PT_PER_MM;

function rgbClose(a: [number, number, number] | null, b: [number, number, number]): boolean {
  if (a == null) return false;
  return (
    Math.abs(a[0] - b[0]) < ANCHOR_INK_TOLERANCE &&
    Math.abs(a[1] - b[1]) < ANCHOR_INK_TOLERANCE &&
    Math.abs(a[2] - b[2]) < ANCHOR_INK_TOLERANCE
  );
}

function bboxCenter(bbox: [number, number, number, number]): { x: number; y: number } {
  return { x: (bbox[0] + bbox[2]) / 2, y: (bbox[1] + bbox[3]) / 2 };
}

/** 在页面的上色形状中找四角锚点并量其真实中心。
 * solid：fill/fillstroke + INK + bbox≈方形 5mm。
 * hollow：stroke/fillstroke + INK 描边 + bbox≈方形 3.8mm + 描边宽≈1.2mm。 */
function measureDrawnAnchors(
  shapes: PaintedShape[],
  pageWidthPt: number,
  pageHeightPt: number,
  anchors: {
    tl: { cx: number; cy: number; fill: string };
    tr: { cx: number; cy: number; fill: string };
    bl: { cx: number; cy: number; fill: string };
    br: { cx: number; cy: number; fill: string };
  },
  pageNo: number,
): WorksheetAnchorMeasurement[] {
  const solids: PaintedShape[] = [];
  const hollows: PaintedShape[] = [];
  for (const shape of shapes) {
    const w = shape.bbox[2] - shape.bbox[0];
    const h = shape.bbox[3] - shape.bbox[1];
    const squareish = Math.abs(w - h) < ANCHOR_SIZE_TOLERANCE_PT;
    if (!squareish) continue;
    if (
      (shape.kind === 'fill' || shape.kind === 'fillstroke') &&
      rgbClose(shape.fillRgb, ANCHOR_INK) &&
      Math.abs(w - ANCHOR_SIZE_PT) < ANCHOR_SIZE_TOLERANCE_PT
    ) {
      solids.push(shape);
      continue;
    }
    if (
      (shape.kind === 'stroke' || shape.kind === 'fillstroke') &&
      rgbClose(shape.strokeRgb, ANCHOR_INK) &&
      Math.abs(w - ANCHOR_STROKE_INNER_PT) < ANCHOR_SIZE_TOLERANCE_PT &&
      Math.abs(shape.strokeWidthPt - ANCHOR_STROKE_PT) < ANCHOR_SIZE_TOLERANCE_PT
    ) {
      hollows.push(shape);
    }
  }

  const measurements: WorksheetAnchorMeasurement[] = [];
  const corners: Array<['tl' | 'tr' | 'bl' | 'br', { cx: number; cy: number; fill: string }]> = [
    ['tl', anchors.tl],
    ['tr', anchors.tr],
    ['bl', anchors.bl],
    ['br', anchors.br],
  ];
  const used = new Set<PaintedShape>();
  for (const [corner, expected] of corners) {
    const pool = expected.fill === 'hollow' ? hollows : solids;
    const expectedXpt = expected.cx * PT_PER_MM;
    const expectedYpt = pageHeightPt - expected.cy * PT_PER_MM; // map y 自上 → PDF y 自下
    const matched = pool.filter((shape) => {
      if (used.has(shape)) return false;
      const c = bboxCenter(shape.bbox);
      return (
        Math.abs(c.x - expectedXpt) <= ANCHOR_CENTER_TOLERANCE_PT &&
        Math.abs(c.y - expectedYpt) <= ANCHOR_CENTER_TOLERANCE_PT
      );
    });
    if (matched.length === 0) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: page ${pageNo} drawn anchor ${corner} ` +
          `(expected ${expected.fill} square near [${expected.cx}, ${expected.cy}]mm) ` +
          `not found among ${solids.length} solid / ${hollows.length} hollow candidates`,
      );
    }
    if (matched.length > 1) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: page ${pageNo} anchor ${corner} matched ${matched.length} drawn shapes — ambiguous`,
      );
    }
    const shape = matched[0];
    used.add(shape);
    const c = bboxCenter(shape.bbox);
    const centerMm: [number, number] = [c.x / PT_PER_MM, (pageHeightPt - c.y) / PT_PER_MM];
    // PDF 与区域图可能一起偏移；另用实际纸张边界校验 8.5mm，不能只比较两者。
    const edgeCenterMm: [number, number] = [
      corner === 'tr' || corner === 'br' ? pageWidthPt / PT_PER_MM - 8.5 : 8.5,
      corner === 'bl' || corner === 'br' ? pageHeightPt / PT_PER_MM - 8.5 : 8.5,
    ];
    if (
      Math.abs(centerMm[0] - edgeCenterMm[0]) > ANCHOR_TOLERANCE_MM ||
      Math.abs(centerMm[1] - edgeCenterMm[1]) > ANCHOR_TOLERANCE_MM
    ) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: page ${pageNo} drawn anchor ${corner} is not 8.5mm from its page edges`,
      );
    }
    const errorMm = Math.max(
      Math.abs(centerMm[0] - expected.cx),
      Math.abs(centerMm[1] - expected.cy),
    );
    if (errorMm > ANCHOR_TOLERANCE_MM) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: page ${pageNo} anchor ${corner} drawn at ` +
          `[${centerMm[0].toFixed(2)}, ${centerMm[1].toFixed(2)}]mm is ${errorMm.toFixed(2)}mm off the map's ` +
          `[${expected.cx}, ${expected.cy}]mm`,
      );
    }
    const w = shape.bbox[2] - shape.bbox[0];
    const sizeMm = (expected.fill === 'hollow' ? w + shape.strokeWidthPt : w) / PT_PER_MM;
    measurements.push({
      corner,
      center_mm: [Number(centerMm[0].toFixed(2)), Number(centerMm[1].toFixed(2))],
      error_mm: Number(errorMm.toFixed(3)),
      size_mm: Number(sizeMm.toFixed(2)),
      kind: expected.fill === 'hollow' ? 'hollow' : 'solid',
    });
  }
  return measurements;
}

/** 硬校验：canonicalize 后的 PDF 字节 vs 区域图。任何不过 → PermanentError。 */
export function verifyWorksheetPdf(
  pdf: Buffer,
  map: WorksheetRegionMapArchiveBodyT,
): WorksheetPdfVerification {
  try {
    return verifyWorksheetPdfInner(pdf, map);
  } catch (error) {
    // 所有解析/解释失败都是确定性（同一字节同一结果）→ 一律永久分类，
    // 不因 helper 抛的是普通 Error 而漏成 pg-boss 重试。
    if (error instanceof WorksheetRenderPermanentError) throw error;
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function verifyWorksheetPdfInner(
  pdf: Buffer,
  map: WorksheetRegionMapArchiveBodyT,
): WorksheetPdfVerification {
  const text = pdf.toString('latin1');
  const xref = parseClassicXref(text, 'verify');

  // --- 页数：/Type /Pages /Count 与 /Type /Page 对象数双证，须等于区域图页数 ---
  let pagesObjNum: number | null = null;
  let declaredCount: number | null = null;
  for (const objNum of xref.objects.keys()) {
    const body = objectRegion(text, xref, objNum, 'verify').body;
    // 只看对象字典段 —— 流字节里可能恰好出现 '/Type /Pages' 字面量。
    const dictPart = body.slice(
      0,
      body.indexOf(' stream') >= 0 ? body.indexOf(' stream') : body.length,
    );
    if (/\/Type\s*\/Pages\b/.test(dictPart)) {
      if (pagesObjNum != null) {
        throw new WorksheetRenderPermanentError(
          'worksheet pdf verify: multiple /Type /Pages nodes (page tree nesting unsupported)',
        );
      }
      pagesObjNum = objNum;
      const count = /\/Count\s+(\d+)/.exec(body);
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body);
      if (count == null || kids == null) {
        throw new WorksheetRenderPermanentError(
          'worksheet pdf verify: /Pages node missing /Count or /Kids',
        );
      }
      declaredCount = Number(count[1]);
    }
  }
  if (pagesObjNum == null || declaredCount == null) {
    throw new WorksheetRenderPermanentError('worksheet pdf verify: no /Type /Pages node found');
  }
  const kidsBody = objectRegion(text, xref, pagesObjNum, 'verify').body;
  const kidRefs = [
    ...(kidsBody.match(/\/Kids\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/(\d+)\s+\d+\s+R/g),
  ].map((m) => Number(m[1]));
  if (kidRefs.length !== declaredCount || declaredCount !== map.pages.length) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: page count mismatch — /Count=${declaredCount}, /Kids=${kidRefs.length}, map=${map.pages.length}`,
    );
  }

  const sortedPages = [...map.pages].sort((a, b) => a.page - b.page);
  const verification: WorksheetPdfVerification = {
    page_count_pdf: declaredCount,
    page_count_map: sortedPages.length,
    pages: [],
  };

  for (let i = 0; i < kidRefs.length; i += 1) {
    const mapPage = sortedPages[i];
    const pageBody = objectRegion(text, xref, kidRefs[i], 'verify').body;
    if (!/\/Type\s*\/Page\b/.test(pageBody) || /\/Type\s*\/Pages\b/.test(pageBody)) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: /Kids entry ${kidRefs[i]} is not a /Type /Page object`,
      );
    }

    // (2) MediaBox vs A4（方向取区域图）。
    const mb = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(
      pageBody,
    );
    if (mb == null) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: page ${mapPage.page} has no /MediaBox`,
      );
    }
    const mbW = Number(mb[3]) - Number(mb[1]);
    const mbH = Number(mb[4]) - Number(mb[2]);
    const expected =
      mapPage.orientation === 'landscape'
        ? { w: A4_PORTRAIT_PT.h, h: A4_PORTRAIT_PT.w }
        : { w: A4_PORTRAIT_PT.w, h: A4_PORTRAIT_PT.h };
    if (
      Math.abs(mbW - expected.w) > MEDIA_BOX_TOLERANCE_PT ||
      Math.abs(mbH - expected.h) > MEDIA_BOX_TOLERANCE_PT
    ) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: page ${mapPage.page} MediaBox ${mbW.toFixed(2)}x${mbH.toFixed(2)}pt ` +
          `is not A4 ${mapPage.orientation} (${expected.w}x${expected.h}pt ±${MEDIA_BOX_TOLERANCE_PT}pt)`,
      );
    }

    // (3) 实测画出来的四角锚点：走完整条内容流（q/Q 栈 + cm 全仿射），
    // 按 producer contract 找出形状、量中心，与区域图 mm 位置对账 ±0.5mm。
    // shrink / 平移 / DPI 变化都直接体现在画出来坐标上。
    const contentsRef = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageBody);
    if (contentsRef == null) {
      throw new WorksheetRenderPermanentError(
        `worksheet pdf verify: page ${mapPage.page} has no single /Contents ref`,
      );
    }
    const { content } = streamObjectContent(text, xref, Number(contentsRef[1]));
    const shapes = interpretPageShapes(content);
    const anchorMeasurements = measureDrawnAnchors(shapes, mbW, mbH, mapPage.anchors, mapPage.page);

    verification.pages.push({
      page: mapPage.page,
      mediabox_pt: [Number(mbW.toFixed(2)), Number(mbH.toFixed(2))],
      orientation: mapPage.orientation,
      anchors: anchorMeasurements,
    });
  }
  return verification;
}

/** window.__tlpWorksheetRegionMap() 的返回形状（ui/worksheet-measure.ts 的
 * WorksheetRegionMapDraft —— 存档体减 pdf_digest）。 */
export type WorksheetRegionMapDraft = Omit<WorksheetRegionMapArchiveBodyT, 'pdf_digest'>;

export interface WorksheetPageRender {
  /** canonicalize 后的 PDF 字节（写入 R2、digest 的对象）。 */
  pdf: Buffer;
  /** 页面内量出的区域图（WorksheetRegionMapArchiveBody 减 pdf_digest）。 */
  regionMap: WorksheetRegionMapDraft;
  /** 被网络边界拦下的非本站请求/跳转/WS（job 结果带出，泄漏可见）。 */
  abortedUrls: string[];
}

async function readPageState(
  page: ChromiumPage,
): Promise<{ state: string | null; error: string | null } | null> {
  try {
    return await page.evaluate(() => ({
      state: document.documentElement.getAttribute('data-worksheet-state'),
      error: document.documentElement.getAttribute('data-worksheet-error'),
    }));
  } catch {
    return null;
  }
}

/** 渲染一份作答卷：开打印页 → 等就绪 → 量区域图 → page.pdf()。
 * `opts.signal` = pg-boss job.signal；`opts.deadlineMs` = 整段浏览器 pass 的
 * 总时限（缺省 RENDER_DEADLINE_MS）。任一触发 ⇒ 主动关 browser，挂起操作
 * reject，诚实失败。 */
export async function renderWorksheetPage(
  input: {
    appOrigin: string;
    exportToken: string;
    internalToken: string;
  },
  opts: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<WorksheetPageRender> {
  const appOrigin = resolveRenderOrigin(input.appOrigin);
  const deadlineMs = opts.deadlineMs ?? RENDER_DEADLINE_MS;
  const abortedUrls: string[] = [];
  // 路由回调内部异常（route.fetch reject 等）。回调不能 throw —— 那会变成
  // 进程级 unhandledRejection —— 但回调失败意味着渲染可能不完整，必须让
  // 整段渲染诚实失败，而不是带着缺资源的页面去存档。收进来、收尾裁决。
  const callbackFailures: string[] = [];

  let browser: ChromiumBrowser | null = null;
  let deadlineHit = false;
  const killBrowser = () => {
    void browser?.close().catch(() => {});
  };
  const timer = setTimeout(() => {
    deadlineHit = true;
    killBrowser();
  }, deadlineMs);
  const onJobSignal = () => killBrowser();
  opts.signal?.addEventListener('abort', onJobSignal, { once: true });

  try {
    browser = await loadPlaywrightCore().chromium.launch();
    const context = await browser.newContext({
      timezoneId: 'Asia/Tokyo',
      // SW 可持缓存绕过 route 拦截 —— 一律禁掉。
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      try {
        // data:/blob:/about: 不出本进程 —— 站点图床（object URL）与内联资源走这里。
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
          // 必须 return await —— 直接 return 未 await 的 promise，其 reject
          // 会逃出 try/catch 重新变成 unhandled rejection。
          return await route.continue();
        }
        if (new URL(url).origin !== appOrigin) {
          abortedUrls.push(url);
          return await route.abort('blockedbyclient');
        }
        // maxRedirects: 0 —— Playwright 自动跟随 3xx 时不会再进本 handler，
        // 同源页面 302 到外站会绕过 allowlist。拿原始 3xx 显式裁决 Location；
        // 同源跳转则由浏览器继续发出下一跳、重新进本 handler 过滤。
        const response = await route.fetch({ maxRedirects: 0 });
        const location = response.headers().location;
        if (response.status() >= 300 && response.status() < 400 && location != null) {
          const target = new URL(location, url);
          if (target.origin !== appOrigin) {
            abortedUrls.push(`${url} -> ${target.href}`);
            return await route.abort('blockedbyclient');
          }
        }
        return await route.fulfill({ response });
      } catch (error) {
        // Grok QA P1-2：route.fetch 在 app 不可达时 reject，未接住的回调 reject
        // 会变成 worker 进程的 unhandledRejection → 整个 worker 连同其他队列的
        // in-flight job 一起被杀。catch 住、记录、abort（自身也 guard），让请求
        // 经 page.goto/资源失败走正常诚实失败路径。
        const message = `${url} (route fetch failed: ${error instanceof Error ? error.message : String(error)})`;
        abortedUrls.push(message);
        callbackFailures.push(message);
        await route.abort('failed').catch(() => {});
        return undefined;
      }
    });
    // WebSocket 不经 route() —— 单独拦：非本站一律关掉并记录。回调内任何异常
    // 同样不能漏成 unhandledRejection（P1-2）。
    await context.routeWebSocket(
      () => true,
      (ws) => {
        try {
          let sameOrigin = false;
          try {
            sameOrigin = new URL(ws.url()).origin === appOrigin;
          } catch {
            sameOrigin = false;
          }
          if (!sameOrigin) {
            abortedUrls.push(`ws:${ws.url()}`);
            ws.close();
            return;
          }
          const server = ws.connectToServer();
          ws.onMessage((message) => {
            try {
              server.send(message);
            } catch {
              /* socket 已关，丢弃 */
            }
          });
          server.onMessage((message) => {
            try {
              ws.send(message);
            } catch {
              /* socket 已关，丢弃 */
            }
          });
        } catch (error) {
          const message = `ws:${ws.url()} (handler failed: ${error instanceof Error ? error.message : String(error)})`;
          abortedUrls.push(message);
          callbackFailures.push(message);
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        }
      },
    );
    // 打印页 apiFetch 从 localStorage 读 internal token（src/ui/lib/api.ts）；
    // 只在受信 origin 上才写入 —— 若页面被 302 带走，外站拿不到 token。
    await context.addInitScript(
      (args: { key: string; token: string; origin: string }) => {
        if (window.location.origin === args.origin) {
          window.localStorage.setItem(args.key, args.token);
        }
      },
      { key: TOKEN_STORAGE_KEY, token: input.internalToken, origin: appOrigin },
    );
    const page = await context.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.goto(`${appOrigin}/print/worksheet/${encodeURIComponent(input.exportToken)}`, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    try {
      await page.waitForFunction(
        () => {
          const state = document.documentElement.getAttribute('data-worksheet-state');
          return state === 'ready' || state === 'error';
        },
        undefined,
        { timeout: READY_TIMEOUT_MS },
      );
    } catch (error) {
      const last = await readPageState(page);
      throw new Error(
        `worksheet render: timed out waiting for data-worksheet-state=ready after ${READY_TIMEOUT_MS}ms` +
          ` (last state=${last?.state ?? 'unreadable'}, error=${last?.error ?? 'none'})`,
        { cause: error },
      );
    }
    const outcome = await readPageState(page);
    if (outcome?.state !== 'ready') {
      // 页面失败码（WorksheetPrintPage.tsx ERROR_COPY）：
      // export_not_found / layout_overflow = 冻结输入决定，重跑必同果 → 永久；
      // load_failed / asset_failed = 可能瞬时 → 走 pg-boss 重试。
      const permanent =
        outcome?.error === 'export_not_found' || outcome?.error === 'layout_overflow';
      const message =
        `worksheet render: print page reported state=${outcome?.state ?? 'unreadable'}` +
        (outcome?.error ? ` error=${outcome.error}` : '');
      if (permanent) throw new WorksheetRenderPermanentError(message);
      throw new Error(message);
    }

    const regionMap = (await page
      .evaluate(() => {
        const measure = (window as { __tlpWorksheetRegionMap?: () => unknown })
          .__tlpWorksheetRegionMap;
        if (measure == null) {
          throw new Error('window.__tlpWorksheetRegionMap is not defined on a ready page');
        }
        return measure();
      })
      .catch((error: unknown) => {
        // ready 页但没有量图 hook = UI/job 版本错配 —— 确定性，永久分类。
        if (
          error instanceof Error &&
          error.message.includes('__tlpWorksheetRegionMap is not defined')
        ) {
          throw new WorksheetRenderPermanentError(
            'worksheet render: ready page has no __tlpWorksheetRegionMap hook (UI/job version mismatch)',
          );
        }
        throw error;
      })) as WorksheetRegionMapDraft;

    // Grok QA P1-1：隐藏测量区 .ws-stage-host（含 297mm 横向样张）若留在 DOM，
    // Chromium 会把 ≥3 页的卷面 shrink-to-fit ~0.73 —— 区域图仍按 1:1 存，PDF
    // 缩水，write-once 存档永久脏。先取图（上面）→ 移除 stage → 再出 PDF。
    const stageGone = await page.evaluate(() => {
      for (const el of document.querySelectorAll('.ws-stage-host')) el.remove();
      return document.querySelector('.ws-stage-host') === null;
    });
    if (!stageGone) {
      throw new WorksheetRenderPermanentError(
        'worksheet render: .ws-stage-host still in the DOM after removal',
      );
    }

    const rawPdf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    let pdf: Buffer;
    try {
      pdf = canonicalizeWorksheetPdf(rawPdf);
    } catch (error) {
      // 字节级 canonicalize 失败同样确定性 → 永久分类。
      throw new WorksheetRenderPermanentError(
        `worksheet render: pdf canonicalize failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (callbackFailures.length > 0) {
      throw new Error(
        `worksheet render: ${callbackFailures.length} route callback failure(s) ` +
          `— render is untrusted: ${callbackFailures.slice(0, 5).join('; ')}`,
      );
    }
    return { pdf, regionMap, abortedUrls };
  } catch (error) {
    // 失败路径也带出被拦请求/回调失败 —— 渲染失败时 result 不落 job.output，
    // 泄漏记录不能随 result 一起丢。
    const leaks =
      (abortedUrls.length > 0 ? ` [aborted off-origin: ${abortedUrls.join(', ')}]` : '') +
      (callbackFailures.length > 0
        ? ` [route callback failures: ${callbackFailures.join('; ')}]`
        : '');
    if (opts.signal?.aborted) {
      throw new Error(`worksheet render aborted: pg-boss job signal fired${leaks}`, {
        cause: error,
      });
    }
    if (deadlineHit) {
      throw new Error(`worksheet render exceeded the ${deadlineMs}ms deadline${leaks}`, {
        cause: error,
      });
    }
    if (leaks !== '' && error instanceof Error) {
      // 追加细节时保持错误类别 —— PermanentError 换成普通 Error 会重新
      // 打开 pg-boss 重试（确定性失败白跑两次）。
      if (error instanceof WorksheetRenderPermanentError) {
        throw new WorksheetRenderPermanentError(`${error.message}${leaks}`, { cause: error });
      }
      throw new Error(`${error.message}${leaks}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onJobSignal);
    if (browser != null) await browser.close().catch(() => {});
  }
}

export type WorksheetRenderResult =
  | {
      status: 'archived' | 'existing';
      export_token: string;
      pdf_digest: string;
      blob_key: string;
      page_count: number;
      aborted_urls: string[];
      verification: WorksheetPdfVerification;
    }
  | {
      status: 'failed_permanent';
      export_token: string;
      reason: string;
    };

export async function runWorksheetRender(
  db: Db,
  input: { export_token: string },
  deps: { appOrigin?: string; internalToken?: string; signal?: AbortSignal } = {},
): Promise<WorksheetRenderResult> {
  try {
    const appOrigin =
      deps.appOrigin ?? process.env.WORKSHEET_RENDER_APP_ORIGIN?.trim() ?? 'http://localhost:5173';
    if (appOrigin === '') {
      throw new WorksheetRenderPermanentError(
        'worksheet_render: WORKSHEET_RENDER_APP_ORIGIN is empty',
      );
    }
    const internalToken = deps.internalToken ?? process.env.INTERNAL_TOKEN;
    if (!internalToken) {
      throw new WorksheetRenderPermanentError(
        'worksheet_render: INTERNAL_TOKEN is not set — the print page cannot authenticate its /api calls',
      );
    }

    const rendered = await renderWorksheetPage(
      { appOrigin, exportToken: input.export_token, internalToken },
      { signal: deps.signal },
    );

    const pdfDigest = `sha256:${createHash('sha256').update(rendered.pdf).digest('hex')}`;
    const parsed = WorksheetRegionMapArchiveBody.safeParse({
      ...rendered.regionMap,
      pdf_digest: pdfDigest,
    });
    if (!parsed.success) {
      // 同一份 DOM 必然量出同一张图 —— 契约不过属确定性，重跑无意义（永久）。
      throw new WorksheetRenderPermanentError(
        `worksheet render: measured region map fails the archive contract: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const body: WorksheetRegionMapArchiveBodyT = parsed.data;

    // 强制校验产物字节（页数/A4 MediaBox/无 shrink/定位点）——不过即渲染失败，
    // 此时尚未写 blob、未触碰存档：无半档、无孤儿。
    const verification = verifyWorksheetPdf(rendered.pdf, body);

    const blobKey = worksheetPdfBlobKey(pdfDigest);
    await putWorksheetExportPdf(pdfDigest, rendered.pdf);

    let out: ArchiveRegionMapResult;
    try {
      out = await archiveWorksheetRegionMap(db, input.export_token, body);
    } catch (error) {
      // write-once 冲突 / 并发抢存：存档事务已整体回滚（无半档），但 blob 已写。
      // content-addressed key ⇒ 同图重跑会原地覆盖，孤儿对象可判可清。
      // 冲突后可重试：同图重渲染 digest 相同 → 落 existing。
      throw new Error(
        `worksheet render: blob '${blobKey}' written but archive failed (orphaned blob, retry-safe): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    switch (out.status) {
      case 'archived':
      case 'existing':
        return {
          status: out.status,
          export_token: input.export_token,
          pdf_digest: pdfDigest,
          blob_key: blobKey,
          page_count: out.archive.page_count,
          aborted_urls: rendered.abortedUrls,
          verification,
        };
      case 'not_found':
        throw new WorksheetRenderPermanentError(
          `worksheet render: export '${input.export_token}' not found`,
        );
      case 'invalid_map':
        throw new WorksheetRenderPermanentError(
          `worksheet render: region map rejected by frozen-issuance validation: ${out.issues
            .map((issue) => `${issue.code}(${issue.detail})`)
            .join('; ')}`,
        );
    }
  } catch (error) {
    if (error instanceof WorksheetRenderPermanentError) {
      // 冻结输入的确定性失败 —— 完结 job 不 retry（P3），原因落 job.output。
      return {
        status: 'failed_permanent',
        export_token: input.export_token,
        reason: error.message,
      };
    }
    throw error;
  }
}

export function buildWorksheetRenderHandler(db: Db): (jobs: Job<unknown>[]) => Promise<unknown> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data as { export_token?: unknown } | null;
      if (typeof data?.export_token !== 'string' || data.export_token.length === 0) {
        throw new Error('worksheet_render: job payload must carry a non-empty export_token');
      }
      const result = await runWorksheetRender(
        db,
        { export_token: data.export_token },
        { signal: job.signal },
      );
      console.log('[worksheet_render]', JSON.stringify(result));
      // batchSize=1：返回值落 job.output（kernel JobHandlerFactory docblock）。
      return result;
    }
    return null;
  };
}

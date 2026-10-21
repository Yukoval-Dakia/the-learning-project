// worksheet PDF 保真层：对象级 canonicalize（抹掉 Chromium 每次
// 渲染打上的墙钟元数据）+ 渲染产物硬校验（页树页数对账 / A4 MediaBox /
// 画出来的四角锚点 ±0.5mm）。
// 由 jobs/worksheet_render.ts 迁出：worker 只保留运行/产物生命周期，本模块
// 独占 PDF 字节解析/规范化/验真责任。字节层在 ./pdf-structure，内容流解释
// 在 ./pdf-content；导出签名与错误时序逐字保持。

import type { WorksheetRegionMapArchiveBodyT } from '@/capabilities/practice/api/worksheet-contracts';

import { type PaintedShape, interpretPageShapes, streamObjectContent } from './pdf-content';
import {
  WorksheetRenderPermanentError,
  collectPageTreeLeaves,
  objectRegion,
  parseClassicXref,
  requiredIndirectRef,
} from './pdf-structure';

// worker 与下层共用同一永久失败类型；经本模块 re-export 使 pdf-fidelity 为
// 唯一公开面（调用方无需深入 pdf-structure / pdf-content）。
export { WorksheetRenderPermanentError } from './pdf-structure';

// ---------- 对象级 PDF canonicalize（R1 P1-3） ----------
// Chromium（Skia/PDF）每次渲染都嵌入墙钟 CreationDate/ModDate（Info 对象），
// 部分版本还在 trailer 放随机 /ID —— 同一份 DOM 出两份不同字节，write-once
// 存档会把重跑误判成冲突。
// 这里做**对象感知**的同长度归一（绝不全文正则扫二进制流）：
// a) 末尾 startxref → xref 表 → trailer 字典（平衡 <<>> 扫描），只改 trailer
// 里的 /ID [<hex><hex>]（十六进制位同长度置 0）；有 /Prev 增量链直接抛错；
// b) trailer /Info N 0 R 指到的对象（按其 xref 偏移定位、endobj 截界）里，
// 只抹 /CreationDate (...) 与 /ModDate (...) 的括串内容（同长度定值）。
// 之后断言：输出长度 === 输入长度；xref 每个 n 条目偏移仍指向 `N G obj`。
// 任何一步不满足都抛错 —— 坏文件诚实失败，不猜、不放宽。

const CANONICAL_PDF_DATE = 'D:19700101000000Z';

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
// 起因：page.pdf 时隐藏测量区 .ws-stage-host 还在 DOM —— 里面的 297mm 横向
// 样张把 ≥3 页的卷面整体 shrink-to-fit 到 ~0.73，四角定位点全偏，但区域图
// 仍按 1:1 mm 存档（write-once 无法补救）。job 侧修复：先取区域图 → 移除
// .ws-stage-host → 再 page.pdf；然后对产物字节做下述硬校验，任何一项不过
// 即判渲染失败：不写 blob、不存档。
// 校验项：
// 1. PDF 页数 === 区域图页数：页树按规范走 trailer /Root → catalog /Pages →
// Kids 显式栈深度优先序取叶子 /Page 序列（任意深度嵌套 —— Skia 多页
// 渲染会产中间层 /Pages 节点）；每个 /Pages 节点声明的 /Count 与其子树
// 实际叶子数逐项对账，叶子总数再与区域图页数对账。属性按对象顶层字典
// 真实 key 解析；/MediaBox、/Rotate 只有本节点未声明才沿祖先链继承，
// 声明而非法（间接/malformed）即抛；/Rotate 全无声明按 0，有效值非 0
// 即抛。重复/环/共享引用、坏 gen 引用一律抛错。
// 2. 每页有效 MediaBox = A4 且原点 [0 0]：portrait 595.28×841.89pt、
// landscape 841.89×595.28pt（方向以区域图为准），±1pt。
// 3. **实测四个画出来的定位点**：有界解释器走页面内容流 —— q/Q 图形状态
// 栈 + cm 复合全仿射（scale、平移都在内，不猜前缀）——收集 fill/stroke
// 上色的路径，按 producer contract（worksheet-svg.tsx Anchor：#1f1e1d
// 的 5mm 实心方块 / BR 1.2mm 描边 3.8mm 空心方块）找出四角锚点，量出
// 它们在该页 PDF 里的真实中心与尺寸，与区域图登记的 mm 位置逐项对账
// （±0.5mm）。shrink/平移/DPI 变化都等价地体现在画出来坐标上 —— 这是
// 对 PDF↔map 一致性的直接证明，不依赖任何流结构假设。找不齐、形态对
// 不上、解不出 → 一律诚实失败，不放行。
// 实测值全部进 job 结果 verification 字段留证。

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

  // --- 页数：页树 /Kids 深度优先序的叶子数 === 区域图页数（每节点 /Count
  // 已在遍历 exit 帧与子树叶子数对账，这里再做总数对账）。
  const leaves = collectPageTreeLeaves(text, xref);
  if (leaves.length !== map.pages.length) {
    throw new WorksheetRenderPermanentError(
      `worksheet pdf verify: page count mismatch — page tree resolves ` +
        `${leaves.length} leaf page(s), map=${map.pages.length}`,
    );
  }

  const sortedPages = [...map.pages].sort((a, b) => a.page - b.page);
  const verification: WorksheetPdfVerification = {
    page_count_pdf: leaves.length,
    page_count_map: sortedPages.length,
    pages: [],
  };

  for (let i = 0; i < leaves.length; i += 1) {
    const mapPage = sortedPages[i];
    const pageEntries = leaves[i].entries;

    // (2) 有效 MediaBox vs A4（方向取区域图）。
    const mbW = leaves[i].mediaBox[2] - leaves[i].mediaBox[0];
    const mbH = leaves[i].mediaBox[3] - leaves[i].mediaBox[1];
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
    // 渲染契约是单一 /Contents ref —— /Contents 数组或间接引用不是完整单
    // ref，requiredIndirectRef 照抛。
    const contentsObjNum = requiredIndirectRef(
      pageEntries,
      'Contents',
      xref,
      `page ${mapPage.page}`,
    );
    const { content } = streamObjectContent(text, xref, contentsObjNum);
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

import { PDFiumLibrary } from '@hyzyla/pdfium';

import { MAX_PDF_PAGES } from '@/core/limits';
import { ApiError } from '@/kernel/http';

// PDF per-page embedded text layer.
//
// pandoc cannot read PDF, so the source package carries PDFium text instead of
// converted markdown. Pages whose whole layer is a distribution watermark or
// whitespace are classified marker_only/empty, never transcribed into fake text.
//
// Like the renderer: server-only, init/destroy per call to bound the WASM heap,
// and the same page cap applies.

/** Whole-layer distribution watermark (学科网-style `{#{QQ…}#}` token). */
const MARKER_ONLY_RE = /^\{#\{[A-Za-z0-9+/=]{8,}\}#\}$/;

export type PdfTextLayerClass = 'text' | 'marker_only' | 'empty';

export interface PdfPageText {
  /** 0-based page index. */
  index: number;
  layer_class: PdfTextLayerClass;
  /** Whitespace-collapsed character count (the honest "is there text" signal). */
  char_count: number;
  /** Raw text layer, kept verbatim. '' for empty/marker_only pages. */
  text: string;
}

export function classifyPdfTextLayer(raw: string): {
  layer_class: PdfTextLayerClass;
  char_count: number;
} {
  const collapsed = raw.replace(/\s+/g, '');
  if (collapsed.length === 0) return { layer_class: 'empty', char_count: 0 };
  if (MARKER_ONLY_RE.test(collapsed)) {
    return { layer_class: 'marker_only', char_count: collapsed.length };
  }
  return { layer_class: 'text', char_count: collapsed.length };
}

/**
 * Extract the embedded text layer of every page. Returns one entry per page;
 * pages without usable text report layer_class 'empty' | 'marker_only' with
 * text ''. Throws ApiError for corrupt/encrypted/over-cap documents (same
 * user-facing contract as renderPdfToPngPages).
 */
export async function extractPdfTextLayers(
  pdfBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<PdfPageText[]> {
  const library = await PDFiumLibrary.init();
  let document: Awaited<ReturnType<typeof library.loadDocument>> | undefined;
  try {
    try {
      document = await library.loadDocument(pdfBytes);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (
        msg.includes('password') ||
        msg.includes('encrypt') ||
        msg.includes('permission') ||
        msg.includes('security')
      ) {
        throw new ApiError('validation_error', 'PDF 已加密，暂不支持。请先移除密码后再上传', 400);
      }
      throw new ApiError('validation_error', '无法解析 PDF（文件可能损坏或不是有效 PDF）', 400);
    }

    const pageCount = document.getPageCount();
    if (pageCount === 0) {
      throw new ApiError('validation_error', 'PDF 没有任何页', 400);
    }
    if (pageCount > MAX_PDF_PAGES) {
      throw new ApiError(
        'validation_error',
        `PDF 共 ${pageCount} 页，超过单次 ${MAX_PDF_PAGES} 页上限，请拆分后上传`,
        400,
      );
    }

    const pages: PdfPageText[] = [];
    for (let i = 0; i < pageCount; i++) {
      if (signal?.aborted) {
        throw new ApiError('request_aborted', 'PDF 文字层读取已中止（客户端已断开连接）', 499);
      }
      const raw = document.getPage(i).getText();
      const { layer_class, char_count } = classifyPdfTextLayer(raw);
      pages.push({ index: i, layer_class, char_count, text: layer_class === 'text' ? raw : '' });
    }
    return pages;
  } finally {
    document?.destroy();
    library.destroy();
  }
}

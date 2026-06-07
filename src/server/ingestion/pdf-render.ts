import { PDFiumLibrary, type PDFiumPageRenderOptions } from '@hyzyla/pdfium';
import sharp from 'sharp';

import { MAX_PDF_PAGES } from '@/core/limits';
import { ApiError } from '@/server/http/errors';

// PDF → page-image renderer (YUK-250). Server-only; imported by the route
// handler app/api/ingestion/pdf/route.ts, NOT by the pg-boss worker graph
// (scripts/worker.ts imports only @/db/client + @/server/boss/*). Keep it that
// way so build:worker stays untouched.
//
// Library: @hyzyla/pdfium (MIT, zero system deps — PDFium compiled to WASM and
// bundled in the npm package). We call the default ESM `PDFiumLibrary.init()`
// with NO options, so in Node the vendor module loads its WASM from the sibling
// dist/pdfium.wasm via `new URL("pdfium.wasm", import.meta.url)` at runtime.
// (The base64-embedded variant is the SEPARATE `@hyzyla/pdfium/browser/base64`
// entry, which this code does NOT use.) Because the wasm is a real on-disk file
// reached through import.meta.url, '@hyzyla/pdfium' MUST stay in
// next.config.ts `serverExternalPackages` — otherwise webpack inlines the JS,
// import.meta.url breaks, and @vercel/nft never copies pdfium.wasm into the
// standalone build shipped to the NAS container (the first PDF upload would
// then 500). See next.config.ts for the full rationale.
//
// Each page renders to a raw BGRA bitmap which we pipe into the existing
// `sharp` dependency to encode lossless PNG (matches the image/png asset
// contract; no new image codec dependency).

// 150 DPI is the OCR/VLM sweet spot — crisp glyphs without blowing up the
// base64 payload sent per-page to Tencent + the VLM. PDFium's scale=1 ≈ 72 DPI,
// so 150 DPI ≈ 150/72 scale. (Avoid 300 DPI: ~4× base64 inflation per page.)
const RENDER_SCALE = 150 / 72;

// Wall-clock guard for the WHOLE document render. Guards a pathological PDF so
// the worst case is one bounded failure, not a hung route handler.
//
// CAVEAT (timeout bounds the RESPONSE, not the work): on timeout we lose the
// `Promise.race` and return 400, but the underlying `renderPages` is NOT
// cancelled — there is no AbortController / cooperative cancel into PDFium, so
// a pathological page keeps consuming CPU + WASM heap to completion in the
// background, freeing only in renderPages' own `finally`. Bounded and
// acceptable on this single-user NAS tool given the 15-page cap (MAX_PDF_PAGES);
// if this ever moves off the single-user envelope, thread cancellation by
// checking an aborted flag between the per-page `document.getPage(i).render(...)`
// iterations and bailing.
export const PDF_RENDER_TIMEOUT_MS = 30_000;

// Per-rendered-page byte ceiling — rendered page assets still flow through the
// 8 MB image asset contract, so a single 150-DPI page that encodes larger than
// this fails loudly rather than silently down-scaling.
const MAX_RENDERED_PAGE_BYTES = 8_000_000;

export interface RenderedPage {
  png: Uint8Array;
}

// Some PDFium load failures surface as password / encryption errors; map those
// to the dedicated user-facing message. The PDFium WASM error strings are not a
// stable public contract, so match loosely on the words that actually appear.
function isEncryptionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('password') ||
    msg.includes('encrypt') ||
    msg.includes('permission') ||
    msg.includes('security')
  );
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  // "%PDF-" === [0x25, 0x50, 0x44, 0x46, 0x2d]. A valid PDF starts with this
  // within the first few bytes (some files have a leading BOM / whitespace).
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 5 <= head.length; i++) {
    if (
      head[i] === 0x25 &&
      head[i + 1] === 0x50 &&
      head[i + 2] === 0x44 &&
      head[i + 3] === 0x46 &&
      head[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

async function renderToPng(options: PDFiumPageRenderOptions): Promise<Uint8Array> {
  const png = await sharp(options.data, {
    raw: { width: options.width, height: options.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

async function renderPages(pdfBytes: Uint8Array): Promise<RenderedPage[]> {
  const library = await PDFiumLibrary.init();
  let document: Awaited<ReturnType<typeof library.loadDocument>> | undefined;
  try {
    try {
      document = await library.loadDocument(pdfBytes);
    } catch (err) {
      if (isEncryptionError(err)) {
        throw new ApiError('validation_error', 'PDF 已加密，暂不支持。请先移除密码后再上传', 400);
      }
      throw new ApiError('validation_error', '无法解析 PDF（文件可能损坏或不是有效 PDF）', 400);
    }

    const pageCount = document.getPageCount();
    if (pageCount === 0) {
      throw new ApiError('validation_error', 'PDF 没有任何页', 400);
    }
    if (pageCount > MAX_PDF_PAGES) {
      // Fail fast BEFORE rendering any page.
      throw new ApiError(
        'validation_error',
        `PDF 共 ${pageCount} 页，超过单次 ${MAX_PDF_PAGES} 页上限，请拆分后上传`,
        400,
      );
    }

    const pages: RenderedPage[] = [];
    for (let i = 0; i < pageCount; i++) {
      // `await` per page keeps the Node event loop fed (sharp's toBuffer is
      // async), so a multi-page render does not starve the loop.
      const rendered = await document.getPage(i).render({
        scale: RENDER_SCALE,
        render: renderToPng,
      });
      const png = rendered.data;
      if (png.byteLength > MAX_RENDERED_PAGE_BYTES) {
        throw new ApiError('validation_error', `第 ${i + 1} 页渲染后超过单页 8MB 上限`, 400);
      }
      pages.push({ png });
    }
    return pages;
  } finally {
    // Free the WASM heap regardless of success/failure so heap does not grow
    // across requests.
    document?.destroy();
    library.destroy();
  }
}

/**
 * Render a PDF to one PNG page image per page, content-addressable downstream.
 *
 * Throws `ApiError('validation_error', <中文>, 400)` for every user-facing
 * failure (corrupt / encrypted / zero pages / over the page cap / render
 * timeout / oversized rendered page). The caller's try/catch → errorResponse
 * turns these into a 400 with the message.
 */
export async function renderPdfToPngPages(pdfBytes: Uint8Array): Promise<RenderedPage[]> {
  if (!hasPdfMagic(pdfBytes)) {
    throw new ApiError('validation_error', '无法解析 PDF（文件可能损坏或不是有效 PDF）', 400);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ApiError(
          'validation_error',
          `PDF 渲染超时（${Math.round(PDF_RENDER_TIMEOUT_MS / 1000)}s），请尝试更小的文件`,
          400,
        ),
      );
    }, PDF_RENDER_TIMEOUT_MS);
  });

  try {
    return await Promise.race([renderPages(pdfBytes), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { MAX_PDF_PAGES };

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/server/http/errors';
import { MAX_PDF_PAGES, renderPdfToPngPages } from './pdf-render';

// Pure renderer unit test — imports only pdf-render.ts + sharp (no DB/R2/AI),
// so it lives in the unit partition (enumerated in vitest.shared.ts
// fastTestInclude alongside crop.test.ts).

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '../../../tests/fixtures/pdf');

function fixture(name: string): Uint8Array {
  const buf = readFileSync(join(FIX, name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderPdfToPngPages', () => {
  it('renders a 2-page PDF to exactly 2 valid PNG pages at ~150 DPI', async () => {
    const pages = await renderPdfToPngPages(fixture('sample-2page.pdf'));
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      const meta = await sharp(Buffer.from(page.png)).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
      // US-Letter (612x792 pt) at 150 DPI → 1275x1650 px. Allow a small
      // tolerance for any rounding in the rasterizer.
      expect(meta.width).toBeGreaterThanOrEqual(1270);
      expect(meta.width).toBeLessThanOrEqual(1280);
      expect(meta.height).toBeGreaterThanOrEqual(1645);
      expect(meta.height).toBeLessThanOrEqual(1655);
      // Each page stays well under the 8 MB per-asset cap.
      expect(page.png.byteLength).toBeLessThan(8_000_000);
    }
  });

  it('is deterministic — same PDF renders byte-identical page PNGs', async () => {
    const bytes = fixture('sample-2page.pdf');
    const a = await renderPdfToPngPages(bytes);
    const b = await renderPdfToPngPages(bytes);
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(Buffer.from(a[i].png).equals(Buffer.from(b[i].png))).toBe(true);
    }
  });

  it('rejects a corrupt PDF (magic ok, body garbage) with the parse error', async () => {
    await expect(renderPdfToPngPages(fixture('corrupt.pdf'))).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
      message: expect.stringContaining('无法解析 PDF'),
    });
  });

  it('rejects non-PDF bytes (no %PDF- magic) before touching PDFium', async () => {
    const notPdf = new TextEncoder().encode('hello, not a pdf at all');
    await expect(renderPdfToPngPages(notPdf)).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
      message: expect.stringContaining('无法解析 PDF'),
    });
  });

  it('rejects a >MAX_PDF_PAGES PDF (the 16-page fixture trips the page cap)', async () => {
    expect(MAX_PDF_PAGES).toBe(15);
    await expect(renderPdfToPngPages(fixture('sample-16page.pdf'))).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
      message: expect.stringContaining(`${MAX_PDF_PAGES}`),
    });
  });

  // NOTE: the encrypted-PDF error mapping is covered in the sibling
  // pdf-render-encryption.test.ts, which fully mocks @hyzyla/pdfium to throw a
  // password error from loadDocument (a real spec-correct encrypted PDF fixture
  // is impractical to hand-author, and PDFium's WASM error strings are not a
  // stable public contract — the renderer matches loosely on the password /
  // encrypt / permission keywords).

  it('throws ApiError instances (so the route try/catch → 400)', async () => {
    const err = await renderPdfToPngPages(fixture('corrupt.pdf')).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
  });
});

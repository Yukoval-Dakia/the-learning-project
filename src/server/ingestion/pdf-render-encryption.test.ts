import { describe, expect, it, vi } from 'vitest';

// Encrypted-PDF error-mapping unit. This file fully mocks @hyzyla/pdfium so
// loadDocument rejects with a password error — deterministically exercising the
// renderer's encryption branch without a hand-authored encrypted PDF fixture
// (which is impractical to author spec-correctly) and without depending on
// PDFium's WASM error strings (not a stable public contract). Pure unit (no
// DB/R2/AI) → unit partition.

const loadDocument = vi.fn();
const destroyLib = vi.fn();

vi.mock('@hyzyla/pdfium', () => ({
  PDFiumLibrary: {
    init: vi.fn(async () => ({
      loadDocument,
      destroy: destroyLib,
    })),
  },
}));

// sharp is never reached on the encryption path (loadDocument throws first), but
// mock it so the module graph stays pure and import-light.
vi.mock('sharp', () => ({ default: vi.fn() }));

import { renderPdfToPngPages } from './pdf-render';

// Bytes that pass the "%PDF-" magic-byte gate so control reaches loadDocument.
const PDF_MAGIC = new TextEncoder().encode('%PDF-1.4\nencrypted placeholder\n');

describe('renderPdfToPngPages — encryption mapping', () => {
  it('maps a password/encryption load error to the 加密 message', async () => {
    loadDocument.mockRejectedValueOnce(new Error('Incorrect password or document is encrypted'));
    await expect(renderPdfToPngPages(PDF_MAGIC)).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
      message: expect.stringContaining('PDF 已加密'),
    });
    // The WASM library handle is still freed in the finally even on load failure.
    expect(destroyLib).toHaveBeenCalled();
  });

  it('maps a non-encryption load error to the generic parse message', async () => {
    loadDocument.mockRejectedValueOnce(new Error('File not in PDF format or corrupted'));
    await expect(renderPdfToPngPages(PDF_MAGIC)).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
      message: expect.stringContaining('无法解析 PDF'),
    });
  });
});

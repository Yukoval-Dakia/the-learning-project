import { beforeEach, describe, expect, it, vi } from 'vitest';

// YUK-522 — cooperative-abort unit. This file fully mocks @hyzyla/pdfium so the
// per-page render loop can be driven deterministically: page 0's render resolves
// AND aborts the controller, so the between-pages `signal.aborted` check must
// reject with the request_aborted ApiError before page 1 is ever rendered. Pure
// unit (no DB/R2/AI) → unit partition.

const renderPage = vi.fn();
const destroyDoc = vi.fn();
const destroyLib = vi.fn();

vi.mock('@hyzyla/pdfium', () => ({
  PDFiumLibrary: {
    init: vi.fn(async () => ({
      loadDocument: vi.fn(async () => ({
        getPageCount: () => 3,
        getPage: (i: number) => ({ render: () => renderPage(i) }),
        destroy: destroyDoc,
      })),
      destroy: destroyLib,
    })),
  },
}));

// sharp is never reached (the mock render bypasses the renderToPng callback),
// but mock it so the module graph stays pure and import-light.
vi.mock('sharp', () => ({ default: vi.fn() }));

import { renderPdfToPngPages } from './pdf-render';

// Bytes that pass the "%PDF-" magic-byte gate so control reaches loadDocument.
const PDF_MAGIC = new TextEncoder().encode('%PDF-1.4\nabort placeholder\n');

// Small stand-in page payload; the mocked render callback bypasses sharp so the
// bytes never need to be a real PNG.
const PAGE_DATA = { data: new Uint8Array([0x89, 0x50]) };

beforeEach(() => {
  renderPage.mockReset();
  destroyDoc.mockClear();
  destroyLib.mockClear();
});

describe('renderPdfToPngPages — cooperative abort (YUK-522)', () => {
  it('rejects with the request_aborted ApiError when the signal aborts mid-render after page 1', async () => {
    const controller = new AbortController();
    renderPage.mockImplementation(async (i: number) => {
      // Abort WHILE page 0's render is resolving — the loop must observe it
      // before asking for page 1.
      if (i === 0) controller.abort();
      return PAGE_DATA;
    });

    await expect(renderPdfToPngPages(PDF_MAGIC, controller.signal)).rejects.toMatchObject({
      code: 'request_aborted',
      status: 499,
    });
    // Bailed between pages: exactly one page rendered; pages 1–2 never asked for.
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(renderPage).toHaveBeenCalledWith(0);
    // WASM handles are still freed in the finally on the abort path.
    expect(destroyDoc).toHaveBeenCalled();
    expect(destroyLib).toHaveBeenCalled();
  });

  it('rejects before rendering any page when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    renderPage.mockResolvedValue(PAGE_DATA);

    await expect(renderPdfToPngPages(PDF_MAGIC, controller.signal)).rejects.toMatchObject({
      code: 'request_aborted',
      status: 499,
    });
    expect(renderPage).not.toHaveBeenCalled();
    expect(destroyDoc).toHaveBeenCalled();
    expect(destroyLib).toHaveBeenCalled();
  });

  it('renders every page when a live signal is threaded but never aborts', async () => {
    const controller = new AbortController();
    renderPage.mockResolvedValue(PAGE_DATA);

    const pages = await renderPdfToPngPages(PDF_MAGIC, controller.signal);
    expect(pages).toHaveLength(3);
    expect(renderPage).toHaveBeenCalledTimes(3);
    expect(destroyLib).toHaveBeenCalled();
  });
});

// PDF fixture generator for the YUK-250 renderer tests.
//
// Run: `node tests/fixtures/pdf/generate.mjs`
//
// Produces three small, auditable PDF fixtures by emitting the raw PDF byte
// structure (header + numbered objects + xref table + trailer) — no binary blob
// committed by hand, no external PDF library needed. Re-run to regenerate.
//
//   sample-2page.pdf  — minimal valid 2-page text PDF (each page draws a string)
//   sample-16page.pdf — 16-page text PDF, exceeds MAX_PDF_PAGES=15 (cap test)
//   corrupt.pdf       — starts with "%PDF-" but the body is truncated garbage
//
// NOTE: an `encrypted.pdf` fixture is intentionally NOT generated here. Authoring
// a spec-correct encrypted PDF (standard security handler, RC4/AES key
// derivation) by hand is error-prone; the renderer's encryption error path is
// covered at the unit level by injecting a load error instead. See
// pdf-render.test.ts.

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Build a minimal valid PDF with `pageCount` pages. Each page has a tiny content
 * stream that writes its 1-based page number using the standard Helvetica font.
 *
 * Object layout (1-indexed):
 *   1  Catalog
 *   2  Pages (Kids = all page objects)
 *   3  Font (Helvetica)
 *   for each page p (0-based): two objects —
 *     pageObjNum     = 4 + p*2      Page
 *     contentObjNum  = 4 + p*2 + 1  Contents stream
 */
function buildPdf(pageCount) {
  const pageObjNums = [];
  for (let p = 0; p < pageCount; p++) pageObjNums.push(4 + p * 2);

  const objects = [];
  // 1: Catalog
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  // 2: Pages
  objects[2] =
    `<< /Type /Pages /Count ${pageCount} ` +
    `/Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] >>`;
  // 3: Font
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (let p = 0; p < pageCount; p++) {
    const pageObjNum = 4 + p * 2;
    const contentObjNum = pageObjNum + 1;
    const text = `Page ${p + 1}`;
    const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    objects[pageObjNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum} 0 R >>`;
    objects[contentObjNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  const totalObjs = objects.length - 1; // index 0 unused
  let body = '%PDF-1.4\n';
  // Binary marker comment so tools treat the file as binary-safe.
  body += '%\xE2\xE3\xCF\xD3\n';

  const offsets = [];
  for (let n = 1; n <= totalObjs; n++) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }

  const xrefStart = body.length;
  let xref = `xref\n0 ${totalObjs + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let n = 1; n <= totalObjs; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'latin1');
}

async function main() {
  const twoPage = buildPdf(2);
  const sixteenPage = buildPdf(16);
  // "%PDF-" prefix but truncated/garbage body → magic passes, parse fails.
  const corrupt = Buffer.from('%PDF-1.4\nthis is not a real pdf body\n', 'latin1');

  await fs.writeFile(join(OUT_DIR, 'sample-2page.pdf'), twoPage);
  await fs.writeFile(join(OUT_DIR, 'sample-16page.pdf'), sixteenPage);
  await fs.writeFile(join(OUT_DIR, 'corrupt.pdf'), corrupt);

  console.log('wrote sample-2page.pdf', twoPage.length, 'bytes');
  console.log('wrote sample-16page.pdf', sixteenPage.length, 'bytes');
  console.log('wrote corrupt.pdf', corrupt.length, 'bytes');
}

main();

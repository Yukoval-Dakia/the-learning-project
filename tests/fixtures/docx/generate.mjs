// DOCX fixture generator for the YUK-258 ingestion tests.
//
// Run: `node tests/fixtures/docx/generate.mjs`
//
// Produces two SELF-AUTHORED (零版权) .docx fixtures by hand-emitting the minimal
// OOXML package (a zip of [Content_Types].xml + word/document.xml + rels + an
// embedded PNG for the text sample). No external Word/LibreOffice/docx-lib needed
// — fflate (already in deps) zips the parts. Re-run to regenerate.
//
//   yuwen-text.docx     — ZERO MathType OLE → classify() must route 'text'.
//                         Carries 2 numbered questions, A–D options, one default
//                         blank (____), and one inline image so the segmenter +
//                         noise-filter paths have real input.
//   math-mathtype.docx  — contains an <o:OLEObject ProgID="Equation.DSMT4" ...>
//                         (MathType) → classify() must route 'visual'.
//
// 版权红线: ONLY这两个自造样本进 repo。真卷 (real-*.docx) 绝不 git add。
//
// The pre-converted text-line artifacts (yuwen-text.md + media/) are produced by a
// SEPARATE one-shot local docker pandoc run (see this dir's README intent in the
// plan §7); the markdown-segment test reads those committed artifacts, never runs
// pandoc itself.

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const enc = new TextEncoder();

// A 1x1 transparent PNG (67 bytes) — smallest valid PNG, used as the embedded
// image in yuwen-text.docx so the package has a real word/media/ part. (The
// noise-filter "微小尺寸" path is exercised against the pre-converted media in the
// segmenter test, not against this docx directly.)
const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const CONTENT_TYPES_TEXT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS_TEXT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

function para(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

// A run holding an inline drawing referencing rId10 (the embedded image).
const INLINE_IMAGE_PARA = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="990000" cy="990000"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId10" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

const DOCUMENT_TEXT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${para('一、选择题（自造样本，无 MathType）')}
    ${para('1. 下列词语读音完全正确的一项是')}
    ${para('A. 锲而不舍')}
    ${para('B. 戛然而止')}
    ${para('C. 言简意赅')}
    ${para('D. 锐不可当')}
    ${INLINE_IMAGE_PARA}
    ${para('2. 在横线上填写恰当的词语：春天来了，万物____。')}
    <w:sectPr/>
  </w:body>
</w:document>`;

// MathType OLE — the load-bearing string is ProgID="Equation.DSMT4". The OLE bin
// itself can be a stub; classify() only counts the ProgID substring in document.xml.
const CONTENT_TYPES_MATH = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const DOCUMENT_MATH = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${para('一、计算题（自造样本，含 MathType 公式 OLE）')}
    <w:p><w:r><w:object><v:shape><v:imagedata r:id="rId10"/></v:shape><o:OLEObject Type="Embed" ProgID="Equation.DSMT4" ShapeID="_x0000_i1026" DrawAspect="Content" ObjectID="_x1" r:id="rId11"/></w:object></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;

const DOC_RELS_MATH = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/>
</Relationships>`;

function buildDocx(parts) {
  // STORE-level zip (level 0) keeps the bytes deterministic + auditable; the
  // OOXML spec doesn't require deflate. fflate writes a standard zip either way.
  return zipSync(parts, { level: 0 });
}

async function main() {
  const yuwen = buildDocx({
    '[Content_Types].xml': enc.encode(CONTENT_TYPES_TEXT),
    '_rels/.rels': enc.encode(ROOT_RELS),
    'word/document.xml': enc.encode(DOCUMENT_TEXT),
    'word/_rels/document.xml.rels': enc.encode(DOC_RELS_TEXT),
    'word/media/image1.png': TINY_PNG,
  });

  const math = buildDocx({
    '[Content_Types].xml': enc.encode(CONTENT_TYPES_MATH),
    '_rels/.rels': enc.encode(ROOT_RELS),
    'word/document.xml': enc.encode(DOCUMENT_MATH),
    'word/_rels/document.xml.rels': enc.encode(DOC_RELS_MATH),
    'word/embeddings/oleObject1.bin': enc.encode('MathType-OLE-stub'),
  });

  await fs.writeFile(join(OUT_DIR, 'yuwen-text.docx'), yuwen);
  await fs.writeFile(join(OUT_DIR, 'math-mathtype.docx'), math);

  console.log('wrote yuwen-text.docx', yuwen.length, 'bytes');
  console.log('wrote math-mathtype.docx', math.length, 'bytes');
}

main();

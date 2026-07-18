import { type UnzipFileInfo, unzipSync } from 'fflate';

import { ApiError } from '@/server/http/errors';

// YUK-258/YUK-273 — DOCX routing + converter security preflight. It runs
// synchronously BEFORE any Pandoc/LibreOffice spawn. A .docx is a zip; we inflate
// only bounded document XML and relationship parts, reject external relationships,
// then count MathType OLE objects in word/document*.xml.
//
//   count > 0 → 'visual'  (MathType 卷: formulas are OLE images — pandoc/OMML
//                          cannot extract them, so the file must go through the
//                          LibreOffice→PDF→PDFium page-image VLM extract path)
//   count = 0 → 'text'    (语文/纯文本卷: pandoc directly converts to markdown,
//                          then the segmenter cuts question_blocks)
//
// Empirical (终矩阵 background): zxxk math papers measured 151/151 MathType with
// zero OMML; 语文 papers measure zero formulas. Mixed papers (some MathType + some
// extractable text) route conservatively to 'visual' — a MathType formula MUST be
// read from the page image, and the text line would silently drop it.

export type DocxLine = 'text' | 'visual';

// MathType OLE ProgID variants all start with `Equation` — `Equation.3`,
// `Equation.DSMT4` (modern MathType), `Equation.2`, etc. Loose substring on the
// `ProgID="Equation` prefix catches every variant without enumerating them.
const MATHTYPE_PROGID_PREFIX = 'ProgID="Equation';

// XML parts that can host an <o:OLEObject .../>. document.xml is the body; some
// producers split content across document2.xml — count both if present.
const DOC_XML_PARTS = ['word/document.xml', 'word/document2.xml'];

// Codex-5 / CodeRabbit-C — classification only needs the document body XML, but
// unzipSync without a filter inflates EVERY archive entry into memory. A ≤20MB
// .docx with a high-ratio payload (e.g. a deeply-compressed media blob) would
// then balloon the request worker's heap before any converter timeout. We pass
// a filter so only DOC_XML_PARTS are inflated, and reject any single body part
// whose DECOMPRESSED size exceeds this ceiling (a real document.xml for an exam
// is a few MB at most; 50MB is a generous zip-bomb guard that never trips on a
// legitimate paper).
const MAX_DECOMPRESSED_PART_BYTES = 50_000_000;

// Converters may resolve OOXML relationships while rendering. Reject external
// templates/images/objects before either converter sees the file. Relationship
// parts are tiny in normal documents; these bounds prevent the security preflight
// itself becoming a decompression/count DoS.
const MAX_RELATIONSHIP_PART_BYTES = 1_000_000;
const MAX_RELATIONSHIP_TOTAL_BYTES = 4_000_000;
const MAX_RELATIONSHIP_PARTS = 256;
const RELATIONSHIP_PART_RE = /(?:^|\/)_rels\/[^/]*\.rels$/i;

function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  // XML processors infer BOM-less UTF-16 from the leading '<' NUL pattern.
  // Mirror that sniffing so a converter cannot see relationship tags that this
  // preflight decoded as NUL-filled UTF-8 and consequently failed to inspect.
  if (bytes[0] === 0x3c && bytes[1] === 0x00) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x3c) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, token: string) => {
    const lower = token.toLowerCase();
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(
        lower.slice(lower.startsWith('#x') ? 2 : 1),
        lower.startsWith('#x') ? 16 : 10,
      );
      // XML 1.0 character references cannot name surrogate code points or values
      // beyond Unicode. Map malformed uploads to the same deliberate 400 as a
      // corrupt DOCX instead of leaking RangeError as a route-level 500.
      if (
        !Number.isInteger(codePoint) ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        throw new ApiError('validation_error', '无法解析 DOCX（关系 XML 字符引用无效）', 400);
      }
      return String.fromCodePoint(codePoint);
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[lower] ?? entity;
  });
}

function hasDangerousExternalRelationship(bytes: Uint8Array): boolean {
  const xml = decodeXml(bytes);
  // Custom entities can make raw-text validation diverge from a converter's XML
  // parser. OOXML relationship parts do not require DTDs, so reject them outright.
  if (/<!DOCTYPE\b/i.test(xml)) return true;

  const relationshipTag = /<(?:[\w.-]+:)?Relationship\b([^>]*)\/?\s*>/gi;
  for (const match of xml.matchAll(relationshipTag)) {
    const attributes = new Map<string, string>();
    const attribute = /([\w:.-]+)\s*=\s*(['"])([\s\S]*?)\2/g;
    for (const attr of match[1].matchAll(attribute)) {
      attributes.set(attr[1].toLowerCase(), decodeXmlEntities(attr[3]));
    }
    if (attributes.get('targetmode')?.toLowerCase() !== 'external') continue;
    // External hyperlinks are inert clickable metadata; converters do not fetch
    // them while rendering. Unknown/resource-loading external types stay blocked.
    const type = attributes.get('type')?.toLowerCase() ?? '';
    if (!type.endsWith('/hyperlink')) return true;
  }
  return false;
}

/**
 * Count MathType OLE objects across the document body XML part(s).
 *
 * Throws `ApiError('validation_error', <中文>, 400)` when the bytes are not a
 * valid docx (zip parse failure, or no word/document.xml part) — the route turns
 * that into a loud 400 rather than guessing a line.
 */
export function classifyDocx(docxBytes: Uint8Array): DocxLine {
  const docXmlParts = new Set<string>(DOC_XML_PARTS);
  let relationshipPartCount = 0;
  let relationshipTotalBytes = 0;
  const relationshipPartNames = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    // Only inflate document body XML + relationship parts. The filter runs before
    // inflation, so media/styles/etc. are skipped and size/count bounds can reject
    // suspicious relationship manifests without allocating their contents.
    entries = unzipSync(docxBytes, {
      filter: (file: UnzipFileInfo) => {
        if (docXmlParts.has(file.name)) {
          if (file.originalSize <= MAX_DECOMPRESSED_PART_BYTES) return true;
          throw new ApiError(
            'validation_error',
            '无法解析 DOCX（word/document.xml 解压后过大，可能是异常文件）',
            400,
          );
        }
        if (!RELATIONSHIP_PART_RE.test(file.name)) return false;
        const normalizedName = file.name.toLowerCase();
        if (relationshipPartNames.has(normalizedName)) {
          throw new ApiError('validation_error', '无法解析 DOCX（存在重复关系文件）', 400);
        }
        relationshipPartNames.add(normalizedName);
        relationshipPartCount += 1;
        if (relationshipPartCount > MAX_RELATIONSHIP_PARTS) {
          throw new ApiError('validation_error', '无法解析 DOCX（关系文件数量异常）', 400);
        }
        if (file.originalSize > MAX_RELATIONSHIP_PART_BYTES) {
          throw new ApiError('validation_error', '无法解析 DOCX（关系文件解压后过大）', 400);
        }
        relationshipTotalBytes += file.originalSize;
        if (relationshipTotalBytes > MAX_RELATIONSHIP_TOTAL_BYTES) {
          throw new ApiError('validation_error', '无法解析 DOCX（关系文件解压总量过大）', 400);
        }
        return true;
      },
    });
  } catch (err) {
    // Re-throw our own zip-bomb 400 unchanged; map any fflate parse failure to
    // the generic corrupt-docx 400.
    if (err instanceof ApiError) throw err;
    throw new ApiError('validation_error', '无法解析 DOCX（文件可能损坏或不是有效 .docx）', 400);
  }

  const present = DOC_XML_PARTS.filter((p) => entries[p] != null);
  if (present.length === 0) {
    // A real .docx always carries word/document.xml. Its absence means the upload
    // is a zip but not a Word document (or a corrupt one) → reject, don't guess.
    throw new ApiError(
      'validation_error',
      '无法解析 DOCX（缺少 word/document.xml，可能不是有效 .docx）',
      400,
    );
  }

  for (const [part, bytes] of Object.entries(entries)) {
    if (!RELATIONSHIP_PART_RE.test(part)) continue;
    if (hasDangerousExternalRelationship(bytes)) {
      throw new ApiError(
        'validation_error',
        `DOCX 包含外部资源关系（${part}）；请移除链接图片、模板或对象后重试`,
        400,
      );
    }
  }

  let mathTypeCount = 0;
  for (const part of present) {
    const xml = decodeXml(entries[part]);
    // Count non-overlapping occurrences of the ProgID prefix.
    let from = 0;
    for (;;) {
      const idx = xml.indexOf(MATHTYPE_PROGID_PREFIX, from);
      if (idx === -1) break;
      mathTypeCount += 1;
      from = idx + MATHTYPE_PROGID_PREFIX.length;
    }
  }

  return mathTypeCount > 0 ? 'visual' : 'text';
}

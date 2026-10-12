import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { type UnzipFileInfo, unzipSync, zipSync } from 'fflate';
import type { DocxOmittedExternalRef } from '@/core/schema/docx-omission';

import { ApiError } from '@/kernel/http';

// YUK-258/YUK-273 — DOCX routing + converter security preflight. It runs
// synchronously BEFORE any Pandoc/LibreOffice spawn. A .docx is a zip; we inflate
// only bounded document XML and relationship parts, analyze every relationship
// part for external resource relationships, then count MathType OLE objects in
// word/document*.xml.
//
//   count > 0 → 'visual'  (MathType 卷: formulas are OLE images — pandoc/OMML
//                          cannot extract them, so the file must go through the
//                          LibreOffice→PDF→PDFium page-image VLM extract path)
//   count = 0 → 'text'    (语文/纯文本卷: pandoc directly converts to markdown,
//                          both classifications now enter the same agent tools)
//
// Empirical (终矩阵 background): zxxk math papers measured 151/151 MathType with
// zero OMML; 语文 papers measure zero formulas. Mixed papers (some MathType + some
// extractable text) route conservatively to 'visual' — a MathType formula MUST be
// read from the page image, and the text line would silently drop it.
//
// YUK-1476 (owner 2026-10-11 correction) — external NON-hyperlink relationships in
// header/footer AND body parts no longer reject the whole upload. Decorative
// external resources are instead OMITTED from the CONVERTER INPUT COPY
// (prepareDocxForConversion): the offending <Relationship> entries are removed so
// pandoc/LibreOffice can never resolve — let alone fetch — an external target.
// Internal relationships and media parts (embedded body images, internal fallback
// header/footer images, OLE object binaries) pass through byte-identical, so the
// MathType→'visual' routing and real embedded question images survive unchanged.
// The original upload bytes are never mutated; the honest omission facts + both
// digests flow to the audit via the caller. Every other guard (DOCTYPE / entity /
// XML validity / duplicate-rels / count & size bounds / missing document.xml /
// corrupt zip) stays fail-closed 400.

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

// Converters may resolve OOXML relationships while rendering, so external
// resource relationships must never reach either converter (YUK-1476: omitted
// from the converter-input copy, not passed through). Relationship parts are
// tiny in normal documents; these bounds prevent the security preflight itself
// becoming a decompression/count DoS.
const MAX_RELATIONSHIP_PART_BYTES = 1_000_000;
const MAX_RELATIONSHIP_TOTAL_BYTES = 4_000_000;
const MAX_RELATIONSHIP_PARTS = 256;
const RELATIONSHIP_PART_RE = /(?:^|\/)_rels\/[^/]*\.rels$/i;

// YUK-1476 — the sanitize rebuild inflates EVERY archive entry (not just the
// classification-filtered ones) so the copy can be re-zipped. This is NOT a
// whole-archive-inflation zipbomb: the filter below sees each entry's
// originalSize BEFORE inflation and rejects the archive when the cumulative
// decompressed total exceeds this ceiling. A legitimate ≤20MB exam paper (media
// is already-compressed PNG/JPEG; XML compresses ~10x) decompresses to well
// under 100MB; 200MB is a generous ceiling that still bounds attacker memory.
const MAX_TOTAL_DECOMPRESSED_PART_BYTES = 200_000_000;

// Fixed zip timestamp so the rebuilt copy is deterministic: the same input
// archive always yields the same converter-input bytes (and therefore the same
// converter_input digest in the audit). 1980-01-01 is the DOS zip epoch.
const ZIP_ENTRY_MTIME = new Date('1980-01-01T00:00:00Z');

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

function decodeNumericXmlEntities(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_entity, token: string) => {
    const hexadecimal = token[0]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(hexadecimal ? token.slice(1) : token, hexadecimal ? 16 : 10);
    const validXml10CodePoint =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!validXml10CodePoint) {
      throw new ApiError('validation_error', '无法解析 DOCX（关系 XML 字符引用无效）', 400);
    }
    return String.fromCodePoint(codePoint);
  });
}

function externalResourceRelationshipError(part: string): ApiError {
  return new ApiError(
    'validation_error',
    `DOCX 包含外部资源关系（${part}）；请移除链接图片、模板或对象后重试`,
    400,
  );
}

/** Last URI segment of the relationship Type, lowercased (e.g. 'image'). A public schema constant — never the Target. */
// OPC (ECMA-376 Part 2) mandates this namespace for every relationships part.
// The serializer re-emits it canonically; a part whose root is NOT bound to it is
// not a relationships part a converter would read — sanitize-impossible → reject.
const OPC_RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function relationshipTypeCategory(typeUri: string): string {
  const idx = typeUri.lastIndexOf('/');
  return (idx === -1 ? typeUri : typeUri.slice(idx + 1)).toLowerCase();
}

interface RelationshipPartAnalysis {
  /** DOCTYPE present — entity-expansion / parser-divergence attack shape; always reject. */
  hasDoctype: boolean;
  /** External NON-hyperlink relationships (the resource-loading kind converters must never see). */
  externalResourceRels: Array<{ id: string; type: string }>;
  /**
   * Parsed <Relationships> node with PREFIX-STRIPPED names (detection view —
   * namespace-agnostic superset). Null when the root element is not
   * <Relationships> — such a part carries no strippable relationships.
   */
  relationshipsNode: Record<string, unknown> | null;
  /**
   * P1-1 (R1) — TRUE namespaced shape parsed WITHOUT removeNSPrefix, so xmlns
   * declarations and prefixed names stay visible. fast-xml-parser with
   * removeNSPrefix:true silently DROPS xmlns declarations, which made the
   * previous serializer emit a namespace-less <Relationships> that
   * namespace-aware readers (pandoc/LibreOffice/ElementTree) could not resolve.
   * Null when no element root exists at all.
   */
  namespaced: { rootName: string; node: Record<string, unknown> } | null;
}

function parseRelationships(xml: string): Record<string, unknown> | null {
  let parsed: { Relationships?: Record<string, unknown> };
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      removeNSPrefix: true,
      parseAttributeValue: false,
      processEntities: true,
      strictReservedNames: true,
      isArray: (tagName) => tagName === 'Relationship',
    }).parse(xml) as typeof parsed;
  } catch {
    throw new ApiError('validation_error', '无法解析 DOCX（关系 XML 无效）', 400);
  }
  return parsed.Relationships ?? null;
}

/** True-shape parse: prefixes and xmlns declarations preserved (P1-1). */
function parseRelationshipsNamespaced(
  xml: string,
): { rootName: string; node: Record<string, unknown> } | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      removeNSPrefix: false,
      parseAttributeValue: false,
      processEntities: true,
      strictReservedNames: true,
      isArray: (tagName) => tagName === 'Relationship' || tagName.endsWith(':Relationship'),
    }).parse(xml) as Record<string, unknown>;
  } catch {
    throw new ApiError('validation_error', '无法解析 DOCX（关系 XML 无效）', 400);
  }
  const rootName = Object.keys(parsed).find((key) => key !== '?xml');
  if (rootName == null) return null;
  const node = parsed[rootName];
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return null;
  return { rootName, node: node as Record<string, unknown> };
}

/**
 * Validate + analyze one relationship part. Throws the SAME 400s as the
 * pre-YUK-1476 preflight (invalid numeric reference / invalid XML); returns the
 * facts the omission decision needs: prepareDocxForConversion rejects DOCTYPE
 * outright and strips external non-hyperlink relationships from the copy.
 */
function analyzeRelationshipPart(bytes: Uint8Array): RelationshipPartAnalysis {
  const xml = decodeXml(bytes);
  // Custom entities can make raw-text validation diverge from a converter's XML
  // parser. OOXML relationship parts do not require DTDs, so reject them outright.
  const hasDoctype = /<!DOCTYPE\b/i.test(xml);
  // fast-xml-parser normalizes some forbidden numeric references permissively;
  // validate every numeric reference against XML 1.0 before object parsing.
  decodeNumericXmlEntities(xml);

  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    throw new ApiError('validation_error', '无法解析 DOCX（关系 XML 无效）', 400);
  }

  const relationshipsNode = parseRelationships(xml);
  const namespaced = parseRelationshipsNamespaced(xml);
  if (relationshipsNode == null) {
    return { hasDoctype, externalResourceRels: [], relationshipsNode: null, namespaced };
  }

  const relationships = relationshipElementsOf(relationshipsNode);
  const externalResourceRels: Array<{ id: string; type: string }> = [];
  for (const attributes of relationships) {
    const normalizedAttributes = new Map(
      Object.entries(attributes).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const rawTargetMode = normalizedAttributes.get('targetmode');
    const targetMode =
      typeof rawTargetMode === 'string' ? decodeNumericXmlEntities(rawTargetMode) : '';
    if (targetMode.toLowerCase() !== 'external') continue;
    // External hyperlinks are inert clickable metadata; converters do not fetch
    // them while rendering. Unknown/resource-loading external types are stripped
    // from the converter copy (YUK-1476) — never resolved, never fetched.
    const rawType = normalizedAttributes.get('type');
    const type = typeof rawType === 'string' ? decodeNumericXmlEntities(rawType).toLowerCase() : '';
    if (!type.endsWith('/hyperlink')) {
      const rawId = normalizedAttributes.get('id');
      const id = typeof rawId === 'string' ? decodeNumericXmlEntities(rawId) : '';
      externalResourceRels.push({ id, type: relationshipTypeCategory(type) });
    }
  }
  return { hasDoctype, externalResourceRels, relationshipsNode, namespaced };
}

/** The <Relationship> child elements of a parsed <Relationships> node (always an array via isArray). */
function relationshipElementsOf(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = node.Relationship;
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  return [raw as Record<string, unknown>];
}

interface ClassificationScan {
  entries: Record<string, Uint8Array>;
  relationshipParts: Array<{ part: string; analysis: RelationshipPartAnalysis }>;
}

/**
 * Pass-1 bounded scan behind prepareDocxForConversion: inflate ONLY document
 * body XML + relationship parts under the existing
 * count/size/duplicate bounds, then validate + analyze every relationship part
 * (same 400s as the pre-YUK-1476 preflight).
 */
function scanForClassification(docxBytes: Uint8Array): ClassificationScan {
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

  const relationshipParts: ClassificationScan['relationshipParts'] = [];
  for (const [part, bytes] of Object.entries(entries)) {
    if (!RELATIONSHIP_PART_RE.test(part)) continue;
    relationshipParts.push({ part, analysis: analyzeRelationshipPart(bytes) });
  }
  return { entries, relationshipParts };
}

function classifyLineFromEntries(entries: Record<string, Uint8Array>): DocxLine {
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

// ---------- YUK-1476: converter-input sanitization ----------

/**
 * Result of preparing a DOCX upload for conversion. `converterBytes` is the ONLY
 * byte sequence that may be handed to pandoc/LibreOffice: the original upload
 * when nothing was omitted, otherwise the sanitized rebuild. It is guaranteed to
 * contain zero external non-hyperlink relationship targets (enforced as a
 * post-condition on the rebuilt copy, not just assumed).
 */
export interface DocxConversionPrep {
  line: DocxLine;
  converterBytes: Uint8Array;
  /** Empty when no sanitization was needed (converterBytes === the original upload). */
  omissions: DocxOmittedExternalRef[];
  /** SHA-256 of the ORIGINAL upload bytes (hex). */
  inputSha256: string;
  /** SHA-256 of the converter-input bytes (hex) — equals inputSha256 when unsanitized. */
  converterInputSha256: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Inflate every archive entry under the cumulative decompressed-size ceiling.
 * originalSize is known per entry BEFORE inflation, so a high-ratio (zipbomb)
 * archive is rejected without allocating its payload — this is the same
 * pre-inflation bound technique the pass-1 filter uses, extended to all entries
 * because the rebuild needs every part's bytes.
 */
function unzipAllBounded(docxBytes: Uint8Array): Record<string, Uint8Array> {
  let totalOriginalBytes = 0;
  try {
    return unzipSync(docxBytes, {
      filter: (file: UnzipFileInfo) => {
        // Directory entries carry no content; drop them (standard zips work fine
        // without explicit directory records and every OOXML consumer accepts that).
        if (file.name.endsWith('/')) return false;
        totalOriginalBytes += file.originalSize;
        if (totalOriginalBytes > MAX_TOTAL_DECOMPRESSED_PART_BYTES) {
          throw new ApiError(
            'validation_error',
            '无法解析 DOCX（解压总量过大，可能是异常文件）',
            400,
          );
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('validation_error', '无法解析 DOCX（文件可能损坏或不是有效 .docx）', 400);
  }
}

function escapeXmlAttributeValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function normalizedAttrSnapshot(map: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(map)
      .sort()
      .map((key) => [key, map[key]]),
  );
}

function relationshipAttrSnapshots(node: Record<string, unknown>): string[] {
  return relationshipElementsOf(node).map((rel) => {
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(rel)) {
      if (name === '#text') continue;
      if (typeof value === 'string') attrs[name] = value;
    }
    return normalizedAttrSnapshot(attrs);
  });
}

/**
 * Deterministically re-serialize a relationship part without the omitted
 * <Relationship> elements, PRESERVING the OPC namespace (R1 P1-1).
 *
 * fast-xml-parser with removeNSPrefix:true silently DROPS xmlns declarations, so
 * the sanitizer works from the TRUE-SHAPE parse (removeNSPrefix:false) where
 * prefixes and xmlns declarations stay visible. The root element's namespace is
 * resolved from its own declarations (a root has no ancestor to inherit from)
 * and MUST be the OPC relationships namespace, in default-ns or prefixed form;
 * anything else — foreign namespace, missing declaration, prefixed attributes,
 * mixed child prefixes, non-Relationship children — is sanitize-impossible and
 * rejects fail-closed (the external relationship still rejects the upload,
 * never a bypass). The output re-emits the namespace CANONICALLY as
 * <Relationships xmlns="…package/2006/relationships"> so any namespace-aware
 * reader (pandoc, LibreOffice, ElementTree) can address every surviving
 * relationship. UTF-8 with a fixed prolog (the original may have been UTF-16).
 *
 * Round-trip verified: the output must re-validate, re-parse, contain ZERO
 * external non-hyperlink relationships, and keep every surviving relationship's
 * attributes byte-equal to the original parse.
 */
function serializeSanitizedRelationshipPart(
  analysis: RelationshipPartAnalysis,
  part: string,
): Uint8Array {
  const fail = (): ApiError => externalResourceRelationshipError(part);
  const namespaced = analysis.namespaced;
  if (namespaced == null || analysis.relationshipsNode == null) throw fail();
  const { rootName, node } = namespaced;

  // Root namespace resolution: must be declared on the root element itself.
  const rootPrefix = rootName.includes(':') ? rootName.slice(0, rootName.indexOf(':')) : '';
  const rootNsAttr = rootPrefix === '' ? 'xmlns' : `xmlns:${rootPrefix}`;
  const declaredRootNs = typeof node[rootNsAttr] === 'string' ? (node[rootNsAttr] as string) : null;
  if (declaredRootNs !== OPC_RELATIONSHIPS_NS) throw fail();
  const childName = rootPrefix === '' ? 'Relationship' : `${rootPrefix}:Relationship`;

  const omitIds = new Set(analysis.externalResourceRels.map((rel) => rel.id));

  // The detection view (prefix-stripped) and the true-shape view must agree on
  // the element count; divergence (mixed child prefixes/forms) → refuse.
  const childRaw = node[childName];
  const children: Array<Record<string, unknown>> =
    childRaw == null
      ? []
      : Array.isArray(childRaw)
        ? (childRaw as Array<Record<string, unknown>>)
        : [childRaw as Record<string, unknown>];
  if (relationshipElementsOf(analysis.relationshipsNode).length !== children.length) {
    throw fail();
  }

  const keptAttrMaps: Array<Record<string, string>> = [];
  const keptElements: string[] = [];
  for (const rel of children) {
    const attrs: Array<[name: string, value: string]> = [];
    for (const [name, value] of Object.entries(rel)) {
      if (name === '#text') {
        if (typeof value === 'string' && value.trim() !== '') throw fail();
        continue;
      }
      // Prefixed attributes cannot be faithfully re-emitted unprefixed (and are
      // invalid OPC); non-string values are child elements — both refuse.
      if (name.includes(':') || typeof value !== 'string') throw fail();
      attrs.push([name, value]);
    }
    const id = attrs.find(([name]) => name.toLowerCase() === 'id')?.[1] ?? '';
    if (omitIds.has(id)) continue;
    keptAttrMaps.push(Object.fromEntries(attrs));
    keptElements.push(
      `<Relationship ${attrs.map(([n, v]) => `${n}="${escapeXmlAttributeValue(v)}"`).join(' ')}/>`,
    );
  }

  // Root attributes: skip the child array + whitespace text; DROP all xmlns*
  // declarations (the canonical OPC xmlns is emitted below); keep unprefixed
  // non-declaration attributes verbatim. Anything else refuses.
  const rootAttrs: string[] = [];
  for (const [name, value] of Object.entries(node)) {
    if (name === childName) continue;
    if (name === '#text') {
      if (typeof value === 'string' && value.trim() !== '') throw fail();
      continue;
    }
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    if (name.includes(':') || typeof value !== 'string') throw fail();
    rootAttrs.push(`${name}="${escapeXmlAttributeValue(value)}"`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${OPC_RELATIONSHIPS_NS}"${rootAttrs.length > 0 ? ` ${rootAttrs.join(' ')}` : ''}>${keptElements.join('')}</Relationships>`;

  // Round-trip verification (detection view): valid, zero external resource
  // relationships, kept attribute set survives exactly.
  const rebuiltBytes = new TextEncoder().encode(xml);
  const roundTrip = analyzeRelationshipPart(rebuiltBytes);
  if (roundTrip.hasDoctype || roundTrip.externalResourceRels.length > 0) throw fail();
  const roundTripSnapshots = relationshipAttrSnapshots(roundTrip.relationshipsNode ?? {});
  const keptSnapshots = keptAttrMaps.map(normalizedAttrSnapshot);
  if (
    roundTripSnapshots.length !== keptSnapshots.length ||
    roundTripSnapshots.some((snapshot, i) => snapshot !== keptSnapshots[i])
  ) {
    throw fail();
  }
  return rebuiltBytes;
}

/**
 * Post-condition on the rebuilt archive: re-run the pass-1 classification scan
 * against the COPY and require zero DOCTYPE / external resource relationships
 * anywhere. Defense in depth — a serializer bug surfaces as a loud 400, never as
 * an external target reaching a converter.
 *
 * The prefix-stripping detection view is a SUPERSET of what any namespace-aware
 * converter reads: a converter addresses only elements in the OPC relationships
 * namespace, while the stripped parse sees `Relationship` elements in EVERY
 * namespace (prefixed or default). Zero found in the superset ⟹ zero visible to
 * the converter — this holds regardless of namespace trickery, which is why the
 * post-condition may stay on the stripped parser (P1-1 fixed the SERIALIZED
 * shape separately; addressability is asserted by the namespace-aware readback
 * in route-classify.test.ts).
 */
function assertConverterInputClean(converterBytes: Uint8Array): void {
  const { relationshipParts } = scanForClassification(converterBytes);
  for (const { part, analysis } of relationshipParts) {
    if (analysis.hasDoctype || analysis.externalResourceRels.length > 0) {
      throw externalResourceRelationshipError(part);
    }
  }
}

/**
 * YUK-1476 — classify a DOCX upload AND produce the byte sequence converters may
 * see. External NON-hyperlink relationships in ANY relationship part
 * (header/footer/body/glossary/…) are omitted from the converter-input copy;
 * the original bytes are never mutated and never reach pandoc/LibreOffice once
 * the caller forwards `converterBytes`. Internal relationships, media parts,
 * [Content_Types].xml and word/document*.xml pass through untouched, so real
 * embedded body images and MathType OLE routing survive byte-identical. External
 * HYPERLINK relationships stay (inert metadata — converters never fetch them).
 *
 * Fail-closed rejections preserved: corrupt zip, missing word/document.xml,
 * DOCTYPE / invalid entities / invalid relationship XML, duplicate relationship
 * parts, count/size bounds, and the new cumulative decompression ceiling that
 * bounds the rebuild. Sanitization-impossible shapes also reject (never bypass).
 */
export function prepareDocxForConversion(docxBytes: Uint8Array): DocxConversionPrep {
  const { entries, relationshipParts } = scanForClassification(docxBytes);
  const line = classifyLineFromEntries(entries);

  const partsToRewrite = new Map<string, RelationshipPartAnalysis>();
  const omissions: DocxOmittedExternalRef[] = [];
  for (const { part, analysis } of relationshipParts) {
    // DOCTYPE stays a hard reject even when we could otherwise strip: entity
    // tricks must not ride the omission path.
    if (analysis.hasDoctype) throw externalResourceRelationshipError(part);
    if (analysis.externalResourceRels.length === 0) continue;
    partsToRewrite.set(part, analysis);
    for (const rel of analysis.externalResourceRels) {
      omissions.push({
        part,
        relationshipId: rel.id,
        relationshipType: rel.type,
      });
    }
  }

  const inputSha256 = sha256Hex(docxBytes);
  if (partsToRewrite.size === 0) {
    return {
      line,
      converterBytes: docxBytes,
      omissions: [],
      inputSha256,
      converterInputSha256: inputSha256,
    };
  }

  const allEntries = unzipAllBounded(docxBytes);
  for (const [part, analysis] of partsToRewrite) {
    allEntries[part] = serializeSanitizedRelationshipPart(analysis, part);
  }
  const converterBytes = zipSync(allEntries, { mtime: ZIP_ENTRY_MTIME });
  assertConverterInputClean(converterBytes);
  return {
    line,
    converterBytes,
    omissions,
    inputSha256,
    converterInputSha256: sha256Hex(converterBytes),
  };
}

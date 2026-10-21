import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { type UnzipFileInfo, unzipSync, zipSync } from 'fflate';
import type { DocxOmittedExternalRef } from '@/core/schema/docx-omission';

import { ApiError } from '@/kernel/http';

// DOCX routing and converter security preflight, run before any Pandoc/LibreOffice
// spawn. Only bounded document XML and relationship parts are inflated. Papers with
// MathType OLE objects route to the page-image path because pandoc cannot extract
// those formulas; mixed papers route conservatively to 'visual'.
//
// External non-hyperlink relationships are omitted from the converter-input copy so
// neither converter can resolve or fetch their targets. Internal relationships and
// media pass through byte-identical, and the original upload is never mutated. All
// other malformed-input guards stay fail-closed 400.

export type DocxLine = 'text' | 'visual';

// Every MathType ProgID variant starts with `Equation`, so a substring match avoids
// enumerating them.
const MATHTYPE_PROGID_PREFIX = 'ProgID="Equation';

// Some producers split body content into document2.xml; count both.
const DOC_XML_PARTS = ['word/document.xml', 'word/document2.xml'];

// Inflate only the body parts; a high-ratio media blob must not balloon the heap.
// The decompressed body ceiling is far above a real exam paper.
const MAX_DECOMPRESSED_PART_BYTES = 50_000_000;

// Relationship parts are tiny in normal documents; these bounds keep the preflight
// itself from becoming a decompression/count DoS.
const MAX_RELATIONSHIP_PART_BYTES = 1_000_000;
const MAX_RELATIONSHIP_TOTAL_BYTES = 4_000_000;
const MAX_RELATIONSHIP_PARTS = 256;
const RELATIONSHIP_PART_RE = /(?:^|\/)_rels\/[^/]*\.rels$/i;

// The rebuild needs every entry, so it checks cumulative originalSize before
// inflation and rejects over this ceiling. A real exam paper stays far below it.
const MAX_TOTAL_DECOMPRESSED_PART_BYTES = 200_000_000;

// Fixed timestamp makes the rebuilt copy deterministic, so its audit digest is stable.
const ZIP_ENTRY_MTIME = new Date('1980-01-01T00:00:00Z');

function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  // Mirror XML's BOM-less UTF-16 sniffing; decoding as UTF-8 would hide the very
  // relationship tags this preflight must inspect.
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

// Every relationships part must be bound to this namespace; a part that is not is
// not one a converter would read, so sanitization is impossible and it is rejected.
const OPC_RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Last URI segment of the relationship Type, lowercased (e.g. 'image'). Never the Target. */
function relationshipTypeCategory(typeUri: string): string {
  const idx = typeUri.lastIndexOf('/');
  return (idx === -1 ? typeUri : typeUri.slice(idx + 1)).toLowerCase();
}

interface RelationshipPartAnalysis {
  /** Entity-expansion/parser-divergence shape; always reject. */
  hasDoctype: boolean;
  /** Resource-loading relationships converters must never see. */
  externalResourceRels: Array<{ id: string; type: string }>;
  /** Prefix-stripped detection view; null when the root is not <Relationships>. */
  relationshipsNode: Record<string, unknown> | null;
  /**
   * True namespaced shape, parsed without removeNSPrefix so xmlns declarations
   * survive serialization. Null when there is no element root.
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

/** True-shape parse: prefixes and xmlns declarations preserved. */
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
 * Validates and analyzes one relationship part, throwing 400 for invalid
 * references or XML. Returns the facts needed to reject DOCTYPEs and strip external
 * non-hyperlink relationships.
 */
function analyzeRelationshipPart(bytes: Uint8Array): RelationshipPartAnalysis {
  const xml = decodeXml(bytes);
  // OOXML relationship parts need no DTD, and entity tricks must not create parser
  // divergence, so DOCTYPE is rejected outright.
  const hasDoctype = /<!DOCTYPE\b/i.test(xml);
  // fast-xml-parser is permissive with some forbidden references; check them first.
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
    // External hyperlinks are inert clickable metadata. Other external types are
    // stripped from the converter copy and never fetched.
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

/** The <Relationship> children of a parsed <Relationships> node. */
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
 * Bounded scan that inflates only body XML and relationship parts, then validates
 * and analyzes every relationship part.
 */
function scanForClassification(docxBytes: Uint8Array): ClassificationScan {
  const docXmlParts = new Set<string>(DOC_XML_PARTS);
  let relationshipPartCount = 0;
  let relationshipTotalBytes = 0;
  const relationshipPartNames = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    // The filter runs before inflation, so bounds can reject without allocating.
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
    // Keep our own 400s; map fflate parse failures to the corrupt-docx 400.
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
    // A real .docx always has word/document.xml; absence means it is not a Word doc.
    throw new ApiError(
      'validation_error',
      '无法解析 DOCX（缺少 word/document.xml，可能不是有效 .docx）',
      400,
    );
  }

  let mathTypeCount = 0;
  for (const part of present) {
    const xml = decodeXml(entries[part]);
    // Count non-overlapping occurrences.
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

/**
 * `converterBytes` is the only sequence that may be handed to pandoc/LibreOffice:
 * the original upload when nothing was omitted, otherwise the sanitized rebuild,
 * which is re-checked to contain zero external non-hyperlink targets.
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
 * Inflates every entry under a cumulative ceiling. originalSize is known before
 * inflation, so a zipbomb is rejected without allocating its payload.
 */
function unzipAllBounded(docxBytes: Uint8Array): Record<string, Uint8Array> {
  let totalOriginalBytes = 0;
  try {
    return unzipSync(docxBytes, {
      filter: (file: UnzipFileInfo) => {
        // Directory entries carry no content, and OOXML readers accept zips without them.
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
 * Re-serializes a relationship part without the omitted elements while preserving
 * the OPC namespace, using the true-shape parse because removeNSPrefix drops xmlns.
 * The root must declare the OPC namespace; unprefixed attributes and consistent
 * child naming are required. Any shape that cannot be rewritten faithfully fails
 * closed rather than risk a bypass. Output is canonical UTF-8 with a fixed prolog,
 * then round-trip verified: re-parsed, zero external relationships, and surviving
 * attributes byte-equal.
 */
function serializeSanitizedRelationshipPart(
  analysis: RelationshipPartAnalysis,
  part: string,
): Uint8Array {
  const fail = (): ApiError => externalResourceRelationshipError(part);
  const namespaced = analysis.namespaced;
  if (namespaced == null || analysis.relationshipsNode == null) throw fail();
  const { rootName, node } = namespaced;

  // A root has no ancestor, so the namespace must be declared here.
  const rootPrefix = rootName.includes(':') ? rootName.slice(0, rootName.indexOf(':')) : '';
  const rootNsAttr = rootPrefix === '' ? 'xmlns' : `xmlns:${rootPrefix}`;
  const declaredRootNs = typeof node[rootNsAttr] === 'string' ? (node[rootNsAttr] as string) : null;
  if (declaredRootNs !== OPC_RELATIONSHIPS_NS) throw fail();
  const childName = rootPrefix === '' ? 'Relationship' : `${rootPrefix}:Relationship`;

  const omitIds = new Set(analysis.externalResourceRels.map((rel) => rel.id));

  // Both parses must see the same element count; mixed prefixes/forms refuse.
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
      // Prefixed attributes are invalid OPC; non-strings are child elements.
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

  // Drop xmlns declarations (the canonical one is emitted below), keep unprefixed
  // attributes verbatim, and refuse anything else.
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

  // Round-trip: valid, no external relationships, kept attributes survive exactly.
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
 * Post-condition on the rebuilt archive: zero DOCTYPE or external relationships
 * anywhere. A serializer bug becomes a loud 400 instead of a live target. The
 * prefix-stripped view is a superset of what a namespace-aware converter reads, so
 * zero here means zero visible to the converter.
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
 * Classifies a DOCX and produces the bytes converters may see. External
 * non-hyperlink relationships in any part are omitted from the copy; the original
 * upload is never mutated. Internal relationships, media, content types, and body
 * XML pass through untouched, so embedded images and MathType routing survive.
 * Hyperlinks stay because converters never fetch them. Malformed archives,
 * DOCTYPEs, invalid XML/entities, duplicate parts, size/count overruns, and
 * sanitization-impossible shapes all reject.
 */
export function prepareDocxForConversion(docxBytes: Uint8Array): DocxConversionPrep {
  const { entries, relationshipParts } = scanForClassification(docxBytes);
  const line = classifyLineFromEntries(entries);

  const partsToRewrite = new Map<string, RelationshipPartAnalysis>();
  const omissions: DocxOmittedExternalRef[] = [];
  for (const { part, analysis } of relationshipParts) {
    // DOCTYPE stays a hard reject so entity tricks cannot ride the omission path.
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

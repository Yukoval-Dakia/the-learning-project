import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/kernel/http';

import { type DocxConversionPrep, prepareDocxForConversion } from './route-classify';

// YUK-1476 — scoped security / data-preservation invariants for the DOCX
// converter-input sanitization. No DB, no converter spawn: these prove the
// BYTE-LEVEL contract (original preserved, copy stripped, internal media
// byte-identical, external targets never present in what converters receive)
// that pandoc/LibreOffice depend on downstream. Real-converter acceptance runs
// in the parent's post-fix entrypoint run.

// ---------- fixtures ----------

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const IMAGE_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const TEMPLATE_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate';
const HYPERLINK_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const OFFICE_DOCUMENT_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

const CONTENT_TYPES = strToU8(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
);
const ROOT_RELS = strToU8(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_DOCUMENT_TYPE}" Target="word/document.xml"/></Relationships>`,
);
const DOC_XML = strToU8(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>1. 题面正文</w:t></w:r></w:p></w:body></w:document>',
);
const MATHTYPE_DOC_XML = strToU8(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:object ProgID="Equation.DSMT4"><w:OLEObject/></w:object></w:body></w:document>',
);
const FOOTER_XML = strToU8(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>第 1 页</w:t></w:r></w:p></w:ftr>',
);
// Distinct binary payloads so byte-identity assertions cannot pass by coincidence.
const MEDIA_BODY_IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const MEDIA_FOOTER_IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 11, 12, 13, 14, 15, 16]);

interface RelFixture {
  id: string;
  type: string;
  target: string;
  external?: boolean;
}

function relsXml(rels: RelFixture[]): Uint8Array {
  const body = rels
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('');
  return strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${RELS_NS}">${body}</Relationships>`,
  );
}

function buildDocx(parts: Record<string, Uint8Array>): Uint8Array {
  return zipSync({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'word/document.xml': DOC_XML,
    ...parts,
  });
}

/** The school's politics-paper shape (TEST80e63): footer rels with one internal image + one EXTERNAL image. */
function schoolShapeDocx(): Uint8Array {
  return buildDocx({
    'word/_rels/document.xml.rels': relsXml([
      // Embedded body image (questions 31/32 stem-image shape): INTERNAL, must survive.
      { id: 'rId1', type: IMAGE_TYPE, target: 'media/image1.png' },
      // External hyperlink: inert metadata, must survive untouched.
      { id: 'rId2', type: HYPERLINK_TYPE, target: 'https://example.edu.cn/ref', external: true },
    ]),
    'word/footer1.xml': FOOTER_XML,
    'word/_rels/footer1.xml.rels': relsXml([
      // Internal fallback footer image: must survive.
      { id: 'rId1', type: IMAGE_TYPE, target: 'media/image2.png' },
      // The rejection trigger: external image (NOT a hyperlink).
      { id: 'rId2', type: IMAGE_TYPE, target: 'https://cdn.example.com/logo.png', external: true },
    ]),
    'media/image1.png': MEDIA_BODY_IMAGE,
    'media/image2.png': MEDIA_FOOTER_IMAGE,
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Parse a relationship part of an archive into id → attribute map (test-side independent reader). */
function readRels(archive: Uint8Array, part: string): Map<string, Record<string, string>> {
  const bytes = unzipSync(archive)[part];
  if (bytes == null) return new Map();
  const xml = new TextDecoder('utf-8').decode(bytes);
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
    parseAttributeValue: false,
    processEntities: true,
  }).parse(xml) as {
    Relationships?: { Relationship?: Record<string, unknown> | Array<Record<string, unknown>> };
  };
  const out = new Map<string, Record<string, string>>();
  const rawRelationships = parsed.Relationships?.Relationship ?? [];
  const relationshipList = (
    Array.isArray(rawRelationships) ? rawRelationships : [rawRelationships]
  ) as Array<Record<string, unknown>>;
  for (const rel of relationshipList) {
    const id = typeof rel.Id === 'string' ? rel.Id : '(no-id)';
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(rel)) {
      if (typeof v === 'string') attrs[k] = v;
    }
    out.set(id, attrs);
  }
  return out;
}

function expectApiError(fn: () => unknown, messagePart: string): ApiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('validation_error');
    expect(apiErr.status).toBe(400);
    expect(apiErr.message).toContain(messagePart);
    return apiErr;
  }
  throw new Error(`expected ApiError containing "${messagePart}", got no throw`);
}

// ---------- independent namespace-aware readback (R1 P1-1) ----------

interface NsRelationship {
  namespace: string;
  attrs: Record<string, string>;
}

/**
 * A minimal XML tag tokenizer + in-scope namespace resolver, deliberately NOT
 * fast-xml-parser: it mirrors how a namespace-aware consumer (Python
 * ElementTree / pandoc / LibreOffice) addresses relationships, which is exactly
 * the reader class that saw 0 relationships before the P1-1 fix. Known test-only
 * limitation: attribute values must not contain a literal '>' — true for the
 * canonical serializer output (escaped to &gt;) and for these fixtures.
 */
function namespaceAwareRels(bytes: Uint8Array): {
  rootName: string;
  rootNamespace: string | null;
  relationships: NsRelationship[];
} {
  const xml = new TextDecoder('utf-8').decode(bytes);
  const defaultStack: Array<string | null> = [null];
  const prefixStack: Array<Record<string, string>> = [{}];
  const relationships: NsRelationship[] = [];
  let rootName = '';
  let rootNamespace: string | null = null;
  const tagRe =
    /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let match: RegExpExecArray | null = tagRe.exec(xml);
  while (match != null) {
    const [, closing, rawName, attrText, selfClosing] = match;
    if (closing) {
      defaultStack.pop();
      prefixStack.pop();
      match = tagRe.exec(xml);
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let attrMatch: RegExpExecArray | null = attrRe.exec(attrText);
    while (attrMatch != null) {
      attrs[attrMatch[1]] = attrMatch[2];
      attrMatch = attrRe.exec(attrText);
    }
    const nextDefault = 'xmlns' in attrs ? attrs.xmlns : defaultStack[defaultStack.length - 1];
    const nextPrefixes = { ...prefixStack[prefixStack.length - 1] };
    for (const [name, value] of Object.entries(attrs)) {
      if (name.startsWith('xmlns:')) nextPrefixes[name.slice(6)] = value;
    }
    const prefix = rawName.includes(':') ? rawName.slice(0, rawName.indexOf(':')) : '';
    const ns = prefix === '' ? nextDefault : (nextPrefixes[prefix] ?? null);
    if (rootName === '') {
      rootName = rawName;
      rootNamespace = ns;
    } else if (rawName === 'Relationship' || rawName.endsWith(':Relationship')) {
      relationships.push({ namespace: ns ?? '', attrs });
    }
    if (!selfClosing) {
      defaultStack.push(nextDefault);
      prefixStack.push(nextPrefixes);
    }
    match = tagRe.exec(xml);
  }
  return { rootName, rootNamespace, relationships };
}

// ---------- prepareDocxForConversion: the YUK-1476 omission semantics ----------

describe('prepareDocxForConversion — external refs NEVER reach converters', () => {
  // @invariant security: converter copy carries zero external non-hyperlink rel targets while every internal rel and media part stays byte-identical
  // @fails-if the sanitizer re-emits the stripped external relationship or corrupts the internal footer image rel and media bytes
  it('omits the footer external image, keeps the internal fallback image, preserves every non-rels part byte-identical', () => {
    const original = schoolShapeDocx();
    const prep: DocxConversionPrep = prepareDocxForConversion(original);

    // Routing + honest audit facts.
    expect(prep.line).toBe('text');
    expect(prep.omissions).toEqual([
      {
        part: 'word/_rels/footer1.xml.rels',
        relationshipId: 'rId2',
        relationshipType: 'image',
      },
    ]);
    expect(prep.inputSha256).toBe(sha256(original));
    expect(prep.converterInputSha256).toBe(sha256(prep.converterBytes));
    expect(prep.converterInputSha256).not.toBe(prep.inputSha256);

    // The never-fetched invariant, asserted directly against the copy: zero
    // external non-hyperlink relationships in ANY relationship part.
    const copy = prep.converterBytes;
    const copyRels = readRels(copy, 'word/_rels/footer1.xml.rels');
    expect([...copyRels.keys()].sort()).toEqual(['rId1']);
    expect(copyRels.get('rId1')?.Target).toBe('media/image2.png');
    expect(copyRels.get('rId1')?.TargetMode).toBeUndefined();

    // R1 P1-1 — namespace-aware readback (independent reader): the rebuilt part
    // must address every surviving relationship under the OPC namespace, with
    // the canonical declaration on the root element.
    const footerRelsBytes = unzipSync(copy)['word/_rels/footer1.xml.rels'] as Uint8Array;
    const footerRelsText = new TextDecoder('utf-8').decode(footerRelsBytes);
    expect(footerRelsText).toContain(`<Relationships xmlns="${RELS_NS}">`);
    const nsRead = namespaceAwareRels(footerRelsBytes);
    expect(nsRead.rootName).toBe('Relationships');
    expect(nsRead.rootNamespace).toBe(RELS_NS);
    expect(nsRead.relationships).toEqual([
      {
        namespace: RELS_NS,
        attrs: expect.objectContaining({ Id: 'rId1', Target: 'media/image2.png' }),
      },
    ]);
    const docRelsRead = namespaceAwareRels(
      unzipSync(copy)['word/_rels/document.xml.rels'] as Uint8Array,
    );
    expect(docRelsRead.rootNamespace).toBe(RELS_NS);
    expect(docRelsRead.relationships.map((r) => r.namespace)).toEqual([RELS_NS, RELS_NS]);
    expect(docRelsRead.relationships.map((r) => r.attrs.Id).sort()).toEqual(['rId1', 'rId2']);
    const copyDocRels = readRels(copy, 'word/_rels/document.xml.rels');
    expect([...copyDocRels.keys()].sort()).toEqual(['rId1', 'rId2']);
    expect(copyDocRels.get('rId2')).toMatchObject({ TargetMode: 'External' });
    expect(copyDocRels.get('rId2')?.Type).toBe(HYPERLINK_TYPE);

    // Data preservation: unmodified parts pass through byte-identical (embedded
    // body image media, internal footer image media, body XML, content types).
    const copyEntries = unzipSync(copy);
    const originalEntries = unzipSync(original);
    expect(Buffer.from(copyEntries['media/image1.png']).equals(Buffer.from(MEDIA_BODY_IMAGE))).toBe(
      true,
    );
    expect(
      Buffer.from(copyEntries['media/image2.png']).equals(Buffer.from(MEDIA_FOOTER_IMAGE)),
    ).toBe(true);
    expect(
      Buffer.from(copyEntries['word/document.xml']).equals(
        Buffer.from(originalEntries['word/document.xml']),
      ),
    ).toBe(true);
    expect(
      Buffer.from(copyEntries['[Content_Types].xml']).equals(
        Buffer.from(originalEntries['[Content_Types].xml']),
      ),
    ).toBe(true);
    expect(Buffer.from(copyEntries['word/footer1.xml']).equals(Buffer.from(FOOTER_XML))).toBe(true);
  });

  // @invariant data: embedded body-image rels and media bytes survive body external-ref omission unchanged
  // @fails-if body sanitization drops or mutates the internal embedded image rel or media so question stem images vanish
  it('applies the SAME omission rule to body external images while keeping the real embedded body image (31/32 stem shape)', () => {
    const original = buildDocx({
      'word/_rels/document.xml.rels': relsXml([
        { id: 'rId1', type: IMAGE_TYPE, target: 'media/image1.png' },
        {
          id: 'rId2',
          type: IMAGE_TYPE,
          target: 'https://cdn.example.com/body-linked.png',
          external: true,
        },
      ]),
      'media/image1.png': MEDIA_BODY_IMAGE,
    });
    const prep = prepareDocxForConversion(original);
    expect(prep.omissions).toEqual([
      { part: 'word/_rels/document.xml.rels', relationshipId: 'rId2', relationshipType: 'image' },
    ]);
    const docRels = readRels(prep.converterBytes, 'word/_rels/document.xml.rels');
    expect([...docRels.keys()]).toEqual(['rId1']);
    expect(docRels.get('rId1')?.Target).toBe('media/image1.png');
    const bodyNsRead = namespaceAwareRels(
      unzipSync(prep.converterBytes)['word/_rels/document.xml.rels'] as Uint8Array,
    );
    expect(bodyNsRead.rootNamespace).toBe(RELS_NS);
    expect(bodyNsRead.relationships.map((r) => [r.namespace, r.attrs.Id])).toEqual([
      [RELS_NS, 'rId1'],
    ]);
    // Embedded image media byte-identical → pandoc --extract-media still sees it.
    expect(
      Buffer.from(unzipSync(prep.converterBytes)['media/image1.png']).equals(
        Buffer.from(MEDIA_BODY_IMAGE),
      ),
    ).toBe(true);
  });

  // @invariant security: external template and OLE-object relationships never reach the converter copy, with honest type categories in the audit facts
  // @fails-if non-image external resource relationships pass through the copy or are miscategorized in the omission audit
  it('omits external template/object relationships too, categorized honestly', () => {
    const original = buildDocx({
      'word/_rels/footer1.xml.rels': relsXml([
        { id: 'rId1', type: TEMPLATE_TYPE, target: 'https://example.com/t.dotx', external: true },
        {
          id: 'rId2',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject',
          target: 'https://example.com/o.bin',
          external: true,
        },
      ]),
    });
    const prep = prepareDocxForConversion(original);
    expect(prep.omissions).toEqual([
      {
        part: 'word/_rels/footer1.xml.rels',
        relationshipId: 'rId1',
        relationshipType: 'attachedtemplate',
      },
      {
        part: 'word/_rels/footer1.xml.rels',
        relationshipId: 'rId2',
        relationshipType: 'oleobject',
      },
    ]);
    expect(readRels(prep.converterBytes, 'word/_rels/footer1.xml.rels').size).toBe(0);
  });

  // @invariant data: MathType papers keep visual-line routing while decorative external refs are omitted
  // @fails-if omission touches document.xml or breaks ProgID counting, misrouting to the text line where pandoc silently drops every OLE formula
  it('keeps MathType visual routing while omitting the decorative external ref', () => {
    const original = zipSync({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': ROOT_RELS,
      'word/document.xml': MATHTYPE_DOC_XML,
      'word/footer1.xml': FOOTER_XML,
      'word/_rels/footer1.xml.rels': relsXml([
        {
          id: 'rId1',
          type: IMAGE_TYPE,
          target: 'https://cdn.example.com/logo.png',
          external: true,
        },
      ]),
    });
    const prep = prepareDocxForConversion(original);
    expect(prep.line).toBe('visual');
    expect(prep.omissions).toHaveLength(1);
    expect(readRels(prep.converterBytes, 'word/_rels/footer1.xml.rels').size).toBe(0);
  });

  // @invariant data: a clean upload is forwarded to converters as the exact original bytes with no rebuild
  // @fails-if the prep path rebuilds or mutates bytes when nothing was omitted, drifting converter input away from the uploaded original
  it('forwards the ORIGINAL bytes untouched when nothing needs omission (identity fast path)', () => {
    const clean = buildDocx({
      'word/_rels/document.xml.rels': relsXml([
        { id: 'rId1', type: IMAGE_TYPE, target: 'media/image1.png' },
        { id: 'rId2', type: HYPERLINK_TYPE, target: 'https://example.org/x', external: true },
      ]),
      'media/image1.png': MEDIA_BODY_IMAGE,
    });
    const prep = prepareDocxForConversion(clean);
    expect(prep.omissions).toEqual([]);
    expect(prep.converterBytes).toBe(clean); // same reference — zero-copy, zero mutation
    expect(prep.inputSha256).toBe(prep.converterInputSha256);
    expect(prep.line).toBe('text');
  });

  // @invariant security: prefixed-root OPC parts re-emit canonically so namespace-aware converters can still address every surviving relationship
  // @fails-if the serializer loses the OPC namespace declaration (the P1-1 defect) and namespace-aware readers resolve zero relationships
  it('sanitizes a PREFIXED-root OPC relationship part to the canonical default-ns form', () => {
    const original = buildDocx({
      'word/_rels/footer1.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<pr:Relationships xmlns:pr="${RELS_NS}"><pr:Relationship Id="rId1" Type="${IMAGE_TYPE}" Target="media/image2.png"/><pr:Relationship Id="rId2" Type="${IMAGE_TYPE}" Target="https://cdn.example.com/logo.png" TargetMode="External"/></pr:Relationships>`,
      ),
      'media/image2.png': MEDIA_FOOTER_IMAGE,
    });
    const prep = prepareDocxForConversion(original);
    expect(prep.omissions).toEqual([
      { part: 'word/_rels/footer1.xml.rels', relationshipId: 'rId2', relationshipType: 'image' },
    ]);
    const bytes = unzipSync(prep.converterBytes)['word/_rels/footer1.xml.rels'] as Uint8Array;
    const nsRead = namespaceAwareRels(bytes);
    expect(nsRead.rootName).toBe('Relationships');
    expect(nsRead.rootNamespace).toBe(RELS_NS);
    expect(nsRead.relationships).toEqual([
      {
        namespace: RELS_NS,
        attrs: expect.objectContaining({ Id: 'rId1', Target: 'media/image2.png' }),
      },
    ]);
    expect(
      Buffer.from(unzipSync(prep.converterBytes)['media/image2.png']).equals(
        Buffer.from(MEDIA_FOOTER_IMAGE),
      ),
    ).toBe(true);
  });

  // @invariant security: UTF-16 relationship parts are decoded, stripped of external refs, and re-emitted as self-consistent readable UTF-8
  // @fails-if UTF-16 decode or re-encode mishandles the part, leaving external targets alive or internal rels unparseable for converters
  it('strips external refs from a UTF-16 encoded relationship part and re-emits self-consistent UTF-8', () => {
    const xml = `<?xml version="1.0" encoding="UTF-16" standalone="yes"?>\r\n<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${IMAGE_TYPE}" Target="media/image2.png"/><Relationship Id="rId2" Type="${IMAGE_TYPE}" Target="https://cdn.example.com/logo.png" TargetMode="External"/></Relationships>`;
    // UTF-16LE with BOM
    const utf16Bytes = new Uint8Array(2 + xml.length * 2);
    new DataView(utf16Bytes.buffer).setUint16(0, 0xfeff, true);
    for (let i = 0; i < xml.length; i++) {
      new DataView(utf16Bytes.buffer).setUint16(2 + i * 2, xml.charCodeAt(i), true);
    }
    const original = buildDocx({
      'word/_rels/footer1.xml.rels': utf16Bytes,
      'media/image2.png': MEDIA_FOOTER_IMAGE,
    });
    const prep = prepareDocxForConversion(original);
    expect(prep.omissions).toEqual([
      { part: 'word/_rels/footer1.xml.rels', relationshipId: 'rId2', relationshipType: 'image' },
    ]);
    const kept = readRels(prep.converterBytes, 'word/_rels/footer1.xml.rels');
    expect([...kept.keys()]).toEqual(['rId1']);
    expect(kept.get('rId1')?.Target).toBe('media/image2.png');
    const utf16NsRead = namespaceAwareRels(
      unzipSync(prep.converterBytes)['word/_rels/footer1.xml.rels'] as Uint8Array,
    );
    expect(utf16NsRead.rootNamespace).toBe(RELS_NS);
    expect(utf16NsRead.relationships.map((r) => [r.namespace, r.attrs.Id])).toEqual([
      [RELS_NS, 'rId1'],
    ]);
  });
});

// ---------- fail-closed guards on the sanitize path ----------

describe('prepareDocxForConversion — fail-closed guards preserved', () => {
  // @invariant security: DOCTYPE-bearing relationship parts stay hard 400 rejections, never omission bypasses
  // @fails-if entity-declaration tricks ride the sanitize path and reach a converter's XML parser
  it('still rejects DOCTYPE relationship parts (no omission bypass for entity tricks)', () => {
    const docx = buildDocx({
      'word/_rels/footer1.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE Relationships [<!ENTITY x "y">]><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${IMAGE_TYPE}" Target="https://cdn.example.com/x.png" TargetMode="External"/></Relationships>`,
      ),
    });
    expectApiError(() => prepareDocxForConversion(docx), '外部资源关系');
  });

  // @invariant security: corrupt zip, invalid numeric entities, invalid rels XML, duplicate rels parts, and missing document.xml all still reject 400
  // @fails-if any of these malformed inputs stops throwing and flows toward converter spawn or session creation
  it('still rejects invalid numeric entities / invalid rels XML / duplicates / missing document.xml / non-zip', () => {
    expectApiError(
      () =>
        prepareDocxForConversion(
          buildDocx({
            'word/_rels/document.xml.rels': strToU8(
              `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="&#x0;" Type="${IMAGE_TYPE}" Target="a.png"/></Relationships>`,
            ),
          }),
        ),
      '字符引用无效',
    );
    expectApiError(
      () =>
        prepareDocxForConversion(
          buildDocx({
            'word/_rels/document.xml.rels': strToU8('<not-xml'),
          }),
        ),
      '关系 XML 无效',
    );
    expectApiError(() => prepareDocxForConversion(strToU8('still not a zip')), '不是有效 .docx');
    // duplicate relationship part (case-insensitive name collision)
    expectApiError(
      () =>
        prepareDocxForConversion(
          zipSync({
            '[Content_Types].xml': CONTENT_TYPES,
            '_rels/.rels': ROOT_RELS,
            'word/document.xml': DOC_XML,
            'word/_rels/document.xml.rels': relsXml([]),
            'word/_rels/Document.xml.rels': relsXml([]),
          }),
        ),
      '重复关系文件',
    );
    // missing word/document.xml
    expectApiError(
      () =>
        prepareDocxForConversion(
          zipSync({ '[Content_Types].xml': CONTENT_TYPES, '_rels/.rels': ROOT_RELS }),
        ),
      '缺少 word/document.xml',
    );
  });

  // @invariant security: serializer-unrepresentable relationship parts reject instead of being rewritten unfaithfully
  // @fails-if a part with non-whitespace text is silently rewritten, dropping or altering relationships a converter would read
  it('rejects instead of sanitizing when the relationship part has a shape the serializer cannot faithfully rewrite', () => {
    // Non-whitespace text content inside <Relationships> — well-formed XML, but
    // not representable in the flat OPC relationship schema.
    const docx = buildDocx({
      'word/_rels/footer1.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}">junk<Relationship Id="rId1" Type="${IMAGE_TYPE}" Target="https://cdn.example.com/x.png" TargetMode="External"/></Relationships>`,
      ),
    });
    expectApiError(() => prepareDocxForConversion(docx), '外部资源关系');
  });

  // @invariant security: foreign-namespace roots, prefixed attributes, mixed child prefixes, and missing declarations reject rather than sanitize
  // @fails-if an unfaithful rewrite injects OPC visibility into a part converters would have ignored, or reorders relationship semantics
  it('rejects foreign-namespace roots, prefixed attributes, and mixed child prefixes (R1 P1-1)', () => {
    // Root bound to a FOREIGN namespace: converters ignore such a part entirely;
    // re-emitting it in canonical OPC form would INJECT visibility — reject.
    const foreign = buildDocx({
      'word/_rels/footer1.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://evil.example.invalid/rels"><Relationship Id="rId1" Type="${IMAGE_TYPE}" Target="https://cdn.example.com/x.png" TargetMode="External"/></Relationships>`,
      ),
    });
    expectApiError(() => prepareDocxForConversion(foreign), '外部资源关系');

    // Prefixed attribute on a Relationship — cannot be faithfully re-emitted
    // unprefixed (and is invalid OPC). Prefix declared so the XML stays valid.
    const prefixedAttr = buildDocx({
      'word/_rels/footer1.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}" xmlns:ns="http://x/ns"><Relationship Id="rId1" ns:Z="q" Type="${IMAGE_TYPE}" Target="https://cdn.example.com/x.png" TargetMode="External"/></Relationships>`,
      ),
    });
    expectApiError(() => prepareDocxForConversion(prefixedAttr), '外部资源关系');

    // Mixed child prefixes: the detection view (prefix-stripped) and the
    // true-shape view disagree on the element count — refuse to sanitize.
    const mixed = buildDocx({
      'word/_rels/footer1.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}" xmlns:p="${RELS_NS}"><Relationship Id="rId1" Type="${IMAGE_TYPE}" Target="a.png"/><p:Relationship Id="rId2" Type="${IMAGE_TYPE}" Target="https://cdn.example.com/x.png" TargetMode="External"/></Relationships>`,
      ),
    });
    expectApiError(() => prepareDocxForConversion(mixed), '外部资源关系');

    // No namespace declaration at all on the root — namespace-less parts are
    // unreadable by namespace-aware consumers; refuse to sanitize.
    const noNs = buildDocx({
      'word/_rels/footer1.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships><Relationship Id="rId1" Type="${IMAGE_TYPE}" Target="https://cdn.example.com/x.png" TargetMode="External"/></Relationships>`,
      ),
    });
    expectApiError(() => prepareDocxForConversion(noNs), '外部资源关系');
  });

  // @invariant security: high-ratio archives are rejected at the cumulative pre-inflation ceiling instead of ballooning request memory
  // @fails-if the rebuild inflates the bomb payload past the bound, or the bound starts rejecting clean archives that omit nothing
  it('bounds the rebuild: a high-ratio archive is rejected pre-inflation, not ballooned', () => {
    // 210MB of zeros deflates to ~200KB. The sanitize path (triggered by the
    // footer external ref) must reject it at the cumulative decompressed ceiling
    // BEFORE inflating the payload — the pass-1 scan alone (no external ref
    // present) still accepts the same archive shape.
    const bomb = zipSync({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': ROOT_RELS,
      'word/document.xml': DOC_XML,
      'word/_rels/footer1.xml.rels': relsXml([
        {
          id: 'rId1',
          type: IMAGE_TYPE,
          target: 'https://cdn.example.com/logo.png',
          external: true,
        },
      ]),
      'media/zero.bin': new Uint8Array(210 * 1024 * 1024),
    });
    expect(bomb.byteLength).toBeLessThan(1_000_000); // it really is a compressed bomb
    expectApiError(() => prepareDocxForConversion(bomb), '解压总量过大');

    // Same archive WITHOUT the external ref: nothing to rebuild → no bound trip.
    const lazy = zipSync({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': ROOT_RELS,
      'word/document.xml': DOC_XML,
      'media/zero.bin': new Uint8Array(210 * 1024 * 1024),
    });
    const prep = prepareDocxForConversion(lazy);
    expect(prep.omissions).toEqual([]);
    expect(prep.line).toBe('text');
  });
});

import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

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
});

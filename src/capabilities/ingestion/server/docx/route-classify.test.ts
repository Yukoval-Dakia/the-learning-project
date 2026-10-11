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

// ---------- prepareDocxForConversion: the YUK-1476 omission semantics ----------

describe('prepareDocxForConversion — external refs NEVER reach converters', () => {
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
    // Embedded image media byte-identical → pandoc --extract-media still sees it.
    expect(
      Buffer.from(unzipSync(prep.converterBytes)['media/image1.png']).equals(
        Buffer.from(MEDIA_BODY_IMAGE),
      ),
    ).toBe(true);
  });

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

  it('rebuilds deterministically: same input → same converter bytes + digest', () => {
    const original = schoolShapeDocx();
    const a = prepareDocxForConversion(original);
    const b = prepareDocxForConversion(original);
    expect(Buffer.from(a.converterBytes).equals(Buffer.from(b.converterBytes))).toBe(true);
    expect(a.converterInputSha256).toBe(b.converterInputSha256);
  });

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
  });
});

// ---------- fail-closed guards on the sanitize path ----------

describe('prepareDocxForConversion — fail-closed guards preserved', () => {
  it('still rejects DOCTYPE relationship parts (no omission bypass for entity tricks)', () => {
    const docx = buildDocx({
      'word/_rels/footer1.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE Relationships [<!ENTITY x "y">]><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${IMAGE_TYPE}" Target="https://cdn.example.com/x.png" TargetMode="External"/></Relationships>`,
      ),
    });
    expectApiError(() => prepareDocxForConversion(docx), '外部资源关系');
  });

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

import { eq, inArray } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { learning_session, source_asset, source_document } from '@/db/schema';
import { persistSourceAsset, sha256Hex } from '@/kernel/records/asset-store';
import type { PdfPageText } from './pdf-text';
import type { R2Client, SourceAssetRow } from './persist-image-asset';

// Unified source package for one ingestion session.
//
// This module fills source_document.body_md, its source_package provenance, and the
// SHA'd source_asset rows. Word, PDF, and image uploads all produce the same shape:
// page images always exist so visual content keeps a pixel anchor; text layers are
// recorded as markers rather than fabricated. Markdown fragments carry page anchors:
//   <!-- tlp:page index=N asset=ast1:<asset_id>:<sha12> sha256=<hex> -->
// Tools resolve assets only through ast1 versioned refs, never paths or base64.

// ---------- ast1 versioned asset ref ----------

export const SOURCE_ASSET_REF_VERSION = 'ast1' as const;
/** sha256 hex prefix length carried in refs (copy/transpose detection). */
export const ASSET_REF_DIGEST_PREFIX_LEN = 12;

export interface ParsedAssetRef {
  assetId: string;
  digestPrefix: string;
}

export function formatAssetRef(assetId: string, sha256: string): string {
  return `${SOURCE_ASSET_REF_VERSION}:${assetId}:${sha256.slice(0, ASSET_REF_DIGEST_PREFIX_LEN)}`;
}

export function assetRefForRow(row: Pick<SourceAssetRow, 'id' | 'sha256'>): string {
  return formatAssetRef(row.id, row.sha256);
}

/** Parse `ast1:<asset_id>:<sha12>`; null = malformed (callers report unresolvable). */
export function parseAssetRef(raw: string): ParsedAssetRef | null {
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [version, assetId, digestPrefix] = parts;
  if (version !== SOURCE_ASSET_REF_VERSION) return null;
  if (assetId.length === 0) return null;
  if (!/^[0-9a-f]{12}$/i.test(digestPrefix)) return null;
  return { assetId, digestPrefix: digestPrefix.toLowerCase() };
}

export type AssetRefInput = string | { asset_id: string; digest: string };

export type AssetRefResolution =
  | { status: 'ok'; row: SourceAssetRow; ref: string }
  | { status: 'unresolvable' | 'digest_mismatch'; detail: string };

/**
 * Resolves an ast1 or structured versioned ref to its asset row. A digest mismatch
 * is an error, never a fallback to the latest version.
 */
export async function resolveAssetRef(db: Db, input: AssetRefInput): Promise<AssetRefResolution> {
  let assetId: string;
  let expectedSha: string | null = null;
  let digestPrefix: string | null = null;
  if (typeof input === 'string') {
    const parsed = parseAssetRef(input);
    if (!parsed) {
      return {
        status: 'unresolvable',
        detail: `ref is not a valid ${SOURCE_ASSET_REF_VERSION} asset ref`,
      };
    }
    assetId = parsed.assetId;
    digestPrefix = parsed.digestPrefix;
  } else {
    assetId = input.asset_id;
    const bare = input.digest.replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/i.test(bare)) {
      return { status: 'unresolvable', detail: 'digest is not a sha256:<64hex>' };
    }
    expectedSha = bare.toLowerCase();
  }

  const [row] = await db.select().from(source_asset).where(eq(source_asset.id, assetId)).limit(1);
  if (!row) {
    return { status: 'unresolvable', detail: `asset '${assetId}' not found` };
  }
  const rowSha = row.sha256.toLowerCase();
  if (digestPrefix !== null && !rowSha.startsWith(digestPrefix)) {
    return {
      status: 'digest_mismatch',
      detail: `ref digest prefix '${digestPrefix}' does not match asset sha256 '${row.sha256}'`,
    };
  }
  if (expectedSha !== null && rowSha !== expectedSha) {
    return {
      status: 'digest_mismatch',
      detail: `digest '${expectedSha}' does not match asset sha256 '${row.sha256}'`,
    };
  }
  return { status: 'ok', row, ref: assetRefForRow(row) };
}

/** Reads bytes and re-hashes; a drifted copy is an error. */
export async function loadAssetBytesVerified(
  r2: R2Client,
  row: Pick<SourceAssetRow, 'id' | 'storage_key' | 'sha256'>,
): Promise<Uint8Array> {
  const bytes = await r2.get(row.storage_key);
  if (!bytes) throw new Error(`asset '${row.id}' bytes missing at ${row.storage_key}`);
  const sha = await sha256Hex(bytes);
  if (sha !== row.sha256.toLowerCase()) {
    throw new Error(
      `asset '${row.id}' content drifted: stored sha256 ${row.sha256}, served ${sha}`,
    );
  }
  return bytes;
}

// ---------- package descriptor (provenance.source_package) ----------

export type SourcePackageKind = 'word' | 'pdf' | 'images';

export interface SourcePackageFileEntry {
  asset_id: string;
  sha256: string;
  role:
    | 'original'
    | 'converter_input'
    | 'markdown'
    | 'media'
    | 'page_image'
    | 'page_text'
    | 'rendered_pdf';
  /** Display label (e.g. pandoc media path). Never a filesystem path. */
  name?: string;
  mime: string;
  page_index?: number;
}

export interface SourcePackagePage {
  index: number;
  image_asset_id?: string;
  image_sha256?: string;
  text_asset_id?: string;
  text_sha256?: string;
  /** pdf only: embedded-layer classification; absent for word/images. */
  text_class?: 'text' | 'marker_only' | 'empty';
  text_chars?: number;
}

export interface SourcePackageV1 {
  version: 1;
  kind: SourcePackageKind;
  /** Every persisted artifact (original / markdown / media / pages / pdf). */
  files: SourcePackageFileEntry[];
  /** Page index in session order — the agent's table of contents. */
  pages: SourcePackagePage[];
  /** word only: the whole pandoc markdown asset (document-level text). */
  document_text_asset_id?: string;
  /** word only: rendered-PDF ancestor of the page images. */
  rendered_pdf_asset_id?: string;
  /** word only: pandoc failed, so the package has pages and original but no markdown. */
  markdown_absent_reason?: string;
}

export function readSourcePackage(provenance: unknown): SourcePackageV1 | null {
  if (provenance !== null && typeof provenance === 'object' && 'source_package' in provenance) {
    const pkg = (provenance as Record<string, unknown>).source_package;
    if (
      pkg !== null &&
      typeof pkg === 'object' &&
      (pkg as SourcePackageV1).version === 1 &&
      Array.isArray((pkg as SourcePackageV1).pages) &&
      Array.isArray((pkg as SourcePackageV1).files)
    ) {
      return pkg as SourcePackageV1;
    }
  }
  return null;
}

/** Page anchor comment embedded in body_md before each page's text section. */
export function pageAnchorComment(page: SourcePackagePage): string {
  const asset =
    page.image_asset_id && page.image_sha256
      ? ` asset=${formatAssetRef(page.image_asset_id, page.image_sha256)} sha256=${page.image_sha256}`
      : '';
  return `<!-- tlp:page index=${page.index}${asset} -->`;
}

// ---------- pdf producer (api/pdf.ts) ----------

/** Per-page provenance stamp linking a session page asset to its package. */
export interface PdfPackageDraftStamp {
  key: string;
  page_count: number;
  /** 0-based index of THIS page (the stamp is carried on its own image row,
   * so ordering never depends on array position). */
  page_index: number;
  original_asset_id: string;
  original_sha256: string;
  text_asset_id?: string;
  text_sha256?: string;
  text_class: PdfPageText['layer_class'];
  text_chars: number;
  /** The raw text layer itself (only when text_class='text'). Carried here so
   * materializeSourcePackage can write the full anchored body_md without a
   * second storage round-trip. */
  text?: string;
}

export const PDF_PACKAGE_DRAFT_KEY = 'source_package_draft' as const;

/**
 * Persists a PDF's original file and text layers, returning the provenance stamp
 * each page image should carry. The caller persists the images.
 */
export async function preparePdfSourceAssets(
  db: Db,
  r2: R2Client,
  input: { pdfBytes: Uint8Array; textLayers: PdfPageText[] },
): Promise<{ originalAssetId: string; stamps: PdfPackageDraftStamp[] }> {
  const original = await persistSourceAsset(db, r2, {
    bytes: input.pdfBytes,
    mime: 'application/pdf',
    kind: 'pdf',
    provenance: { role: 'original', source_format: 'pdf' },
  });
  const originalSha = await sha256Hex(input.pdfBytes);
  const key = `pdf:${originalSha.slice(0, 16)}`;

  const stamps: PdfPackageDraftStamp[] = [];
  for (const layer of input.textLayers) {
    let textAssetId: string | undefined;
    let textSha: string | undefined;
    if (layer.layer_class === 'text' && layer.text.length > 0) {
      const textBytes = new TextEncoder().encode(layer.text);
      const row = await persistSourceAsset(db, r2, {
        bytes: textBytes,
        mime: 'text/plain',
        kind: 'text',
        provenance: {
          role: 'page_text',
          page_index: layer.index,
          package_key: key,
          derived_from: { asset_id: original.id, digest: `sha256:${originalSha}` },
        },
      });
      textAssetId = row.id;
      textSha = row.sha256;
    }
    stamps.push({
      key,
      page_count: input.textLayers.length,
      page_index: layer.index,
      original_asset_id: original.id,
      original_sha256: originalSha,
      ...(textAssetId ? { text_asset_id: textAssetId, text_sha256: textSha } : {}),
      text_class: layer.layer_class,
      text_chars: layer.char_count,
      ...(layer.layer_class === 'text' && layer.text.length > 0 ? { text: layer.text } : {}),
    });
  }
  return { originalAssetId: original.id, stamps };
}

export function pdfPageImageProvenance(stamp: PdfPackageDraftStamp): Record<string, unknown> {
  return {
    role: 'page_image',
    page_index: stamp.page_index,
    [PDF_PACKAGE_DRAFT_KEY]: stamp,
  };
}

// ---------- materialize (session create / docx attach) ----------

async function loadPackageAssets(db: Db, assetIds: string[]): Promise<SourceAssetRow[]> {
  if (assetIds.length === 0) return [];
  const rows = await db.select().from(source_asset).where(inArray(source_asset.id, assetIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Session asset order IS the page order.
  return assetIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

function draftStamp(row: SourceAssetRow): PdfPackageDraftStamp | null {
  const prov = row.provenance as Record<string, unknown> | null;
  const draft = prov?.[PDF_PACKAGE_DRAFT_KEY];
  if (draft === null || typeof draft !== 'object') return null;
  const d = draft as Record<string, unknown>;
  if (typeof d.key !== 'string' || typeof d.original_asset_id !== 'string') return null;
  return d as unknown as PdfPackageDraftStamp;
}

/**
 * Fills body_md and source_package on an existing document, preserving other
 * provenance keys. Kind is 'pdf' only when every page has the same PDF stamp;
 * otherwise 'images'. Word documents use attachWordSourcePackage.
 */
export async function materializeSourcePackage(
  db: Db,
  sourceDocumentId: string,
): Promise<SourcePackageV1 | null> {
  const [doc] = await db
    .select()
    .from(source_document)
    .where(eq(source_document.id, sourceDocumentId))
    .limit(1);
  if (!doc) return null;
  const assets = await loadPackageAssets(db, doc.source_asset_ids);

  const stamped = assets.flatMap((row) => {
    const stamp = draftStamp(row);
    return stamp ? [{ row, stamp }] : [];
  });
  // A PDF package needs every page stamped, one shared key, matching page counts,
  // and distinct in-range indices; otherwise fall back to the image-only package.
  const pdfReady =
    stamped.length > 0 &&
    stamped.length === assets.length &&
    new Set(stamped.map((p) => p.stamp.key)).size === 1 &&
    new Set(stamped.map((p) => p.stamp.page_count)).size === 1 &&
    stamped[0].stamp.page_count === stamped.length &&
    stamped.every(
      (p) =>
        Number.isInteger(p.stamp.page_index) &&
        p.stamp.page_index >= 0 &&
        p.stamp.page_index < p.stamp.page_count,
    ) &&
    new Set(stamped.map((p) => p.stamp.page_index)).size === stamped.length;

  let pkg: SourcePackageV1;
  let bodyMd: string | null = null;

  if (pdfReady) {
    const ordered = [...stamped].sort((a, b) => a.stamp.page_index - b.stamp.page_index);
    const pages: SourcePackagePage[] = ordered.map(({ row, stamp }) => ({
      index: stamp.page_index,
      image_asset_id: row.id,
      image_sha256: row.sha256,
      ...(stamp.text_asset_id
        ? { text_asset_id: stamp.text_asset_id, text_sha256: stamp.text_sha256 }
        : {}),
      text_class: stamp.text_class,
      text_chars: stamp.text_chars,
    }));
    const files: SourcePackageFileEntry[] = [
      {
        asset_id: ordered[0].stamp.original_asset_id,
        sha256: ordered[0].stamp.original_sha256,
        role: 'original',
        name: 'original.pdf',
        mime: 'application/pdf',
      },
      ...ordered.map(({ row, stamp }) => ({
        asset_id: row.id,
        sha256: row.sha256,
        role: 'page_image' as const,
        mime: row.mime_type,
        page_index: stamp.page_index,
      })),
      ...ordered.flatMap(({ stamp }) =>
        stamp.text_asset_id
          ? [
              {
                asset_id: stamp.text_asset_id,
                sha256: stamp.text_sha256 ?? '',
                role: 'page_text' as const,
                mime: 'text/plain',
                page_index: stamp.page_index,
              },
            ]
          : [],
      ),
    ];
    // One page anchor followed by that page's text layer; empty layers say so.
    const sections = ordered.map(({ stamp }, position) => {
      const lines = [pageAnchorComment(pages[position])];
      if (stamp.text_class === 'text' && typeof stamp.text === 'string' && stamp.text.length > 0) {
        lines.push(stamp.text.trim());
      } else {
        lines.push(
          stamp.text_class === 'marker_only'
            ? '_（本页文字层仅为分发水印标记，无正文）_'
            : '_（本页无嵌入文字层）_',
        );
      }
      return lines.join('\n');
    });
    bodyMd = sections.join('\n\n');
    pkg = { version: 1, kind: 'pdf', files, pages };
  } else {
    const pages: SourcePackagePage[] = assets.map((row, index) => ({
      index,
      image_asset_id: row.id,
      image_sha256: row.sha256,
    }));
    pkg = {
      version: 1,
      kind: 'images',
      files: assets.map((row, index) => ({
        asset_id: row.id,
        sha256: row.sha256,
        role: 'page_image' as const,
        mime: row.mime_type,
        page_index: index,
      })),
      pages,
    };
  }

  const provenance = {
    ...(doc.provenance as Record<string, unknown>),
    source_package: pkg,
  } as typeof source_document.$inferInsert.provenance;
  await db
    .update(source_document)
    .set({ body_md: bodyMd, provenance, updated_at: new Date() })
    .where(eq(source_document.id, sourceDocumentId));
  return pkg;
}

// ---------- word producer (api/docx.ts) ----------

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function mediaMime(path: string): string {
  const suffix = path.toLowerCase().split('.').at(-1) ?? '';
  // SVG is stored as octet-stream so active markup never renders as an image.
  return (
    (
      {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
      } as Record<string, string>
    )[suffix] ?? 'application/octet-stream'
  );
}

/**
 * Rewrites pandoc's relative media references to ast1 refs so the agent-facing
 * markdown contains only resolvable asset identities.
 */
export function rewriteMediaRefs(markdown: string, pathToRef: Map<string, string>): string {
  let out = markdown;
  for (const [path, ref] of pathToRef) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out
      .replace(new RegExp(`\\]\\(${escaped}\\)`, 'g'), `](${ref})`)
      .replace(new RegExp(`src="${escaped}"`, 'g'), `src="${ref}"`);
  }
  return out;
}

export interface PersistedPackageMedia {
  path: string;
  asset_id: string;
  sha256: string;
  mime: string;
}

export interface PackageMediaResult {
  media: PersistedPackageMedia[];
  /** Media dropped by the per-image byte cap — kept honest in the package. */
  omitted: { path: string; reason: string }[];
}

/**
 * Persists pandoc's embedded media. The byte cap applies to opaque binaries too;
 * skipped media stay listed in `omitted` and their markdown refs stay dangling.
 * SVG is stored as octet-stream, never image/svg+xml.
 */
export async function persistPackageMedia(
  db: Db,
  r2: R2Client,
  media: { path: string; bytes: Uint8Array }[],
): Promise<PackageMediaResult> {
  const { MAX_IMAGE_UPLOAD_BYTES } = await import('@/core/limits');
  const out: PersistedPackageMedia[] = [];
  const omitted: PackageMediaResult['omitted'] = [];
  for (const m of media) {
    const mime = mediaMime(m.path);
    if (m.bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
      omitted.push({ path: m.path, reason: `exceeds ${MAX_IMAGE_UPLOAD_BYTES} byte cap` });
      continue;
    }
    const row = await persistSourceAsset(db, r2, {
      bytes: m.bytes,
      mime,
      kind: 'image',
      provenance: { role: 'media', name: m.path },
    });
    out.push({ path: m.path, asset_id: row.id, sha256: row.sha256, mime });
  }
  return { media: out, omitted };
}

export interface AttachWordPackageInput {
  sourceDocumentId: string;
  /** The upload as received (pre-sanitize). */
  originalBytes: Uint8Array;
  /** Bytes the converter actually saw (may equal originalBytes). */
  converterBytes: Uint8Array;
  /** pandoc markdown, or null when tolerant conversion failed. */
  markdown: string | null;
  markdownAbsentReason?: string;
  /** Already-persisted embedded media (persistPackageMedia result). */
  media: PersistedPackageMedia[];
  omittedMedia?: { path: string; reason: string }[];
  /** Rendered page evidence (persistDocxPageEvidence result). */
  pageAssetIds: string[];
  renderedPdfAssetId?: string;
}

/**
 * Writes the word package: original and converter input, source markdown, media and
 * page links, ast1 rewrites, and provenance. Both DOCX lines use it; text documents
 * simply have no OLE media.
 */
export async function attachWordSourcePackage(
  db: Db,
  r2: R2Client,
  input: AttachWordPackageInput,
): Promise<SourcePackageV1> {
  const [doc] = await db
    .select()
    .from(source_document)
    .where(eq(source_document.id, input.sourceDocumentId))
    .limit(1);
  if (!doc) throw new Error(`attachWordSourcePackage: ${input.sourceDocumentId} not found`);

  const files: SourcePackageFileEntry[] = [];
  const save = async (
    bytes: Uint8Array,
    name: string,
    role: SourcePackageFileEntry['role'],
    mime: string,
    kind: 'image' | 'pdf' | 'text' | 'docx',
  ): Promise<SourceAssetRow> => {
    const row = await persistSourceAsset(db, r2, { bytes, mime, kind });
    files.push({ asset_id: row.id, sha256: row.sha256, role, name, mime });
    return row;
  };

  const original = await save(input.originalBytes, 'original.docx', 'original', DOCX_MIME, 'docx');
  // Only persist a converter copy when sanitization changed the bytes.
  const converterSha = await sha256Hex(input.converterBytes);
  if (converterSha !== original.sha256) {
    await save(input.converterBytes, 'converter.docx', 'converter_input', DOCX_MIME, 'docx');
  }

  let mdAsset: SourceAssetRow | null = null;
  if (input.markdown !== null) {
    const mdBytes = new TextEncoder().encode(input.markdown);
    mdAsset = await save(mdBytes, 'source.md', 'markdown', 'text/markdown', 'text');
  }

  const pathToRef = new Map<string, string>();
  for (const m of input.media) {
    files.push({
      asset_id: m.asset_id,
      sha256: m.sha256,
      role: 'media',
      name: m.path,
      mime: m.mime,
    });
    // Match normalizeMediaPath: strip a leading './'.
    pathToRef.set(m.path.replace(/^\.\//, ''), formatAssetRef(m.asset_id, m.sha256));
  }

  const pageRows = await loadPackageAssets(db, input.pageAssetIds);
  const pages: SourcePackagePage[] = pageRows.map((row, index) => {
    files.push({
      asset_id: row.id,
      sha256: row.sha256,
      role: 'page_image',
      mime: row.mime_type,
      page_index: index,
    });
    return { index, image_asset_id: row.id, image_sha256: row.sha256 };
  });
  if (input.renderedPdfAssetId) {
    const [pdfRow] = await db
      .select()
      .from(source_asset)
      .where(eq(source_asset.id, input.renderedPdfAssetId))
      .limit(1);
    if (pdfRow) {
      files.push({
        asset_id: pdfRow.id,
        sha256: pdfRow.sha256,
        role: 'rendered_pdf',
        name: 'rendered.pdf',
        mime: pdfRow.mime_type,
      });
    }
  }

  const bodyMd = input.markdown !== null ? rewriteMediaRefs(input.markdown, pathToRef) : null;
  const pkg: SourcePackageV1 = {
    version: 1,
    kind: 'word',
    files,
    pages,
    ...(mdAsset ? { document_text_asset_id: mdAsset.id } : {}),
    ...(input.renderedPdfAssetId ? { rendered_pdf_asset_id: input.renderedPdfAssetId } : {}),
    ...(input.markdownAbsentReason ? { markdown_absent_reason: input.markdownAbsentReason } : {}),
  };
  const provenance = {
    ...(doc.provenance as Record<string, unknown>),
    source_package: pkg,
    ...(input.omittedMedia?.length ? { source_package_omitted_media: input.omittedMedia } : {}),
  } as typeof source_document.$inferInsert.provenance;
  await db
    .update(source_document)
    .set({ body_md: bodyMd, provenance, updated_at: new Date() })
    .where(eq(source_document.id, input.sourceDocumentId));
  return pkg;
}

/**
 * A package failure must not leave a session orphaned: pre-output sessions are
 * marked failed, while sessions with extracted output are never downgraded and the
 * error is recorded on document provenance instead.
 */
export async function markSessionPackageFailed(
  db: Db,
  sessionId: string,
  err: unknown,
): Promise<'kept_extracted' | 'marked_failed' | 'missing'> {
  const msg = err instanceof Error ? err.message : String(err);
  const [session] = await db
    .select({
      status: learning_session.status,
      source_document_id: learning_session.source_document_id,
    })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  if (!session) return 'missing';
  // Extracted output must not be downgraded: record the attach failure on document
  // provenance and still propagate the original error.
  if (['extracted', 'partial', 'reviewed', 'imported'].includes(session.status)) {
    if (session.source_document_id) {
      try {
        const [doc] = await db
          .select({ provenance: source_document.provenance })
          .from(source_document)
          .where(eq(source_document.id, session.source_document_id))
          .limit(1);
        await db
          .update(source_document)
          .set({
            provenance: {
              ...((doc?.provenance as Record<string, unknown> | null) ?? {}),
              source_package_attach_error: msg.slice(0, 500),
            },
          })
          .where(eq(source_document.id, session.source_document_id));
      } catch {
        // Best-effort marker; the attach error still propagates.
      }
    }
    return 'kept_extracted';
  }
  // No extracted output yet: mark failed so it is not orphaned. Materialization
  // sits outside the session guard, so the route writes this transition.
  await db
    .update(learning_session)
    .set({
      status: 'failed',
      error_message: `source_package: ${msg.slice(0, 500)}`,
      updated_at: new Date(),
    })
    .where(eq(learning_session.id, sessionId));
  return 'marked_failed';
}

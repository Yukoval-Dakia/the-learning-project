import { eq, inArray } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { learning_session, source_asset, source_document } from '@/db/schema';
import { persistSourceAsset, sha256Hex } from '@/kernel/records/asset-store';
import type { PdfPageText } from './pdf-text';
import type { R2Client, SourceAssetRow } from './persist-image-asset';

// YUK-1404 (B2/R1) — unified source package.
//
// One ingestion session owns one source_document row (created by the session
// guards, unchanged). This module fills in the package the ingestion agent
// consumes:
//
//   source_document.body_md                — full anchored markdown
//   source_document.provenance.source_package — SourcePackageV1 descriptor
//   source_asset rows                      — original file, converted markdown,
//                                            embedded media, page images,
//                                            per-page text layers (each SHA'd)
//
// Three input shapes produce the SAME package shape:
//   word  — pandoc gfm markdown + all embedded media + rendered page images
//           (LibreOffice→PDF→PDFium; the page images are always produced so
//           MathType / layout questions keep a pixel anchor).
//   pdf   — per-page embedded text layer (pdfium; marker/empty layers are
//           marked, never transcribed into fake text) + per-page image.
//   images — photos / scans: pages carry images only, no text.
//
// The anchor convention (salvaged from feat/yuk-1404-anchored-markdown,
// adapted to product refs) maps every markdown fragment back to its page:
//
//   <!-- tlp:page index=N asset=ast1:<asset_id>:<sha12> sha256=<hex> -->
//
// Package provenance keeps the full descriptor; tools resolve assets through
// the ast1 versioned ref only — never paths, URLs or base64.

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
 * Resolve an agent-facing ref to its source_asset row. `ast1:` strings carry a
 * sha prefix; the structured form is the shared VersionedAssetRef shape
 * `{asset_id, digest:'sha256:<64hex>'}` (bare 64-hex also accepted). A digest
 * mismatch is an explicit error — NEVER a fallback to the latest version.
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

/** Read asset bytes and re-hash them — a served copy that drifted is an error. */
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
  /** word only: pandoc failed/tolerated — package has page images + original
   * but no markdown (P2-3: the upload must stay additive, not reject). */
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
 * Persist the non-page artifacts of a PDF upload (original file + per-page
 * text layers) and return the provenance stamp each page-image row should
 * carry. Page images themselves are persisted by the caller (existing
 * renderPdfToPngPages flow unchanged).
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
 * Fill `body_md` + `provenance.source_package` on an existing source_document.
 * Idempotent: re-running overwrites the same derived fields only — every other
 * provenance key (entrypoint, subject, omission audit) is preserved.
 *
 * Package kind is derived from evidence the upload actually produced:
 *   - every page asset carrying the same pdf draft stamp → 'pdf'
 *   - otherwise → 'images' (photos/scans/legacy uploads; image-only pages)
 * Word documents attach through attachWordSourcePackage instead (the caller
 * already holds the pandoc output).
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
  // A coherent pdf package requires: every asset stamped, one shared key,
  // page_count agreement and distinct in-range page indices. Anything short of
  // that falls back to the honest image-only package — never fabricated text.
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
    // Anchored markdown: one tlp:page comment per page followed by that page's
    // text layer verbatim; empty/marker layers say so instead of fabricating.
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
  // svg is deliberately absent: stored/served as octet-stream so an active
  // markup file can never be rendered as image content (XSS surface).
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
 * Rewrite pandoc's relative media references (`![](media/image1.png)` and
 * `<img src="media/image1.png">`) to versioned `ast1:` asset refs so the
 * markdown handed to the agent contains only resolvable asset identities.
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
 * Persist pandoc-extracted embedded media. The byte cap applies to ALL media
 * (raster AND opaque binaries like emf/wmf/tiff — an unbounded embed is an
 * unbounded row either way); skipped media land in `omitted` (the markdown
 * keeps its original reference — unrewritten, dangling by design). SVG is
 * stored as octet-stream, never image/svg+xml (P2-4).
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
  /** pandoc markdown, or null when conversion failed on the tolerant path
   * (P2-3 — visual-line uploads must keep working without markdown). */
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
 * Write the 'word' package onto an existing source_document: persists the
 * original + (when sanitized) converter input + source.md, links the already
 * persisted media/page/pdf rows, rewrites the markdown's media references to
 * ast1 refs, and stores the result in body_md + provenance.source_package.
 * Runs for BOTH docx lines — MathType docs keep page images AND the pandoc
 * markdown; plain-text docs simply have no OLE media.
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
  // The converter copy is only a distinct artifact when sanitization changed
  // the bytes (YUK-1476); identical input shares the original's content address.
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
    // normalizeMediaPath parity: strip a leading './' if the manifest path
    // carries one, so markdown refs resolve by the same normalized path.
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
 * P2-8 — package attach/materialize runs AFTER the session row exists
 * (initiateUpload owns its own transaction). A package failure must not leave
 * an `uploaded` orphan behind a 500:
 *   - pre-output sessions (uploaded/queued/extracting) are marked `failed`
 *     with the reason. `uploaded → failed` has no guard transition
 *     (markExtractionFailed only covers queued/extracting), so the route
 *     writes it directly.
 *   - sessions that already produced extracted output (extracted/partial/
 *     reviewed/imported) are never downgraded — imports only admit
 *     extracted/reviewed, so `failed` would orphan a completed upload behind
 *     a transient package/R2 error. The failure is recorded on
 *     `source_document.provenance.source_package_attach_error` instead.
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
  // Codex 4293474481 — sessions that already produced extracted output (the
  // text-DOCX line commits question_blocks and reaches 'extracted' before the
  // package attaches) must not be downgraded: imports only admit
  // extracted/reviewed sessions, so flipping to 'failed' would orphan a
  // completed upload behind a transient package/R2 failure. Record the attach
  // failure on the document provenance instead; the original error still
  // propagates to the caller.
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
        // best-effort marker — the attach error itself is what propagates
      }
    }
    return 'kept_extracted';
  }
  // uploaded/queued/extracting have no extracted output yet: mark the session
  // failed so it is not left orphaned ('uploaded' -> 'failed' is the only
  // pre-output transition the guard allows; package materialization sits
  // outside the guard's coverage, documented in the header comment).
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

import { eq, inArray, sql } from 'drizzle-orm';

import { canonicalHash, sha256Hex } from '@/core/migration/canonical';
import { DocxIntegrity, type DocxIntegrityT } from '@/core/schema/docx-integrity';
import type { Tx } from '@/db/client';
import { question_block, source_asset, source_document } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import type { ImportBodyParsed } from '../../api/import-schema';

type ImportBlock = ImportBodyParsed['blocks'][number];

/** Bind the assertion to exactly what the existing manual import will publish. */
export function docxImportContentHash(block: ImportBlock): string {
  return canonicalHash({
    source_block_ids: block.source_block_ids,
    final_prompt_md: block.final_prompt_md,
    image_refs: block.image_refs,
    page_spans: block.page_spans,
    question_kind: block.question_kind,
  });
}

function reject(message: string): never {
  throw new ApiError('conflict', `DOCX review required: ${message}`, 409);
}

function hasPrompt(prompt: string): boolean {
  return (
    prompt
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/<img\b[^>]*>/gi, '')
      .replace(/[*#_`]/g, '')
      .replace(/^\s*\d{1,3}\\?[.．、]\s*/, '')
      .trim().length > 0
  );
}

/** Runs inside the existing session/block-locked import transaction, before any
 * question is created. Editing a prompt or setting reviewed cannot clear issues.
 * Evidence is an auditable human assertion; source bytes alone prove no ownership.
 */
export async function confirmDocxImport(
  tx: Tx,
  sessionId: string,
  sourceDocumentId: string,
  body: ImportBodyParsed,
): Promise<boolean> {
  const [source] = await tx
    .select()
    .from(source_document)
    .where(eq(source_document.id, sourceDocumentId))
    .for('update');
  if (source?.provenance.line !== 'text') return false;
  const parsed = DocxIntegrity.safeParse(source.provenance.docx_integrity);
  const rows = await tx
    .select()
    .from(question_block)
    .where(eq(question_block.ingestion_session_id, sessionId));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const confirmations = body.docx_confirmations ?? [];
  const used = new Set<number>();
  const integrity = parsed.success ? parsed.data : null;
  const roots = new Map(integrity?.blocks.map((block) => [block.block_id, block]) ?? []);
  const pageIds = new Set(integrity?.page_asset_ids ?? []);
  const mediaIds = new Set(integrity?.media_asset_ids ?? []);
  const assetRows = integrity?.assets.length
    ? await tx
        .select({
          asset_id: source_asset.id,
          sha256: source_asset.sha256,
        })
        .from(source_asset)
        .where(
          inArray(
            source_asset.id,
            integrity.assets.map((a) => a.asset_id),
          ),
        )
    : [];
  const assetDigests = new Map(assetRows.map((a) => [a.asset_id, a.sha256]));
  const pinnedDigests = new Map(integrity?.assets.map((a) => [a.asset_id, a.sha256]) ?? []);
  const verifiedAsset = (asset: { asset_id: string; sha256: string }) =>
    asset.sha256 === pinnedDigests.get(asset.asset_id) &&
    asset.sha256 === assetDigests.get(asset.asset_id);

  for (const block of body.blocks) {
    if (!hasPrompt(block.final_prompt_md)) reject('complete question text is missing');
    // Follow existing editor merges so moving a protected source into another
    // block cannot erase its issue. The session guard already locks these rows.
    const inherited = new Set<string>();
    const visit = (id: string) => {
      if (inherited.has(id)) return;
      inherited.add(id);
      for (const parent of byId.get(id)?.merged_from_block_ids ?? []) visit(parent);
    };
    block.source_block_ids.forEach(visit);
    const selectedMedia = block.image_refs.filter((id) => !pageIds.has(id));
    if (!integrity) {
      if (
        selectedMedia.length ||
        [...inherited].some((id) => {
          const row = byId.get(id);
          return row && (row.image_refs.length || !hasPrompt(row.extracted_prompt_md ?? ''));
        })
      )
        reject('re-extract this legacy source to recover verifiable image evidence');
      continue;
    }
    if (block.page_spans.some((span) => span.page_index >= integrity.page_asset_ids.length)) {
      reject('page span is not a source page');
    }
    if (selectedMedia.some((id) => !mediaIds.has(id))) reject('unknown embedded media');
    // A new manual card can still be made from a source block. Require that
    // lineage for DOCX image work instead of an untraceable image-only card.
    if (!inherited.size && block.image_refs.length)
      reject('link the manual card to its source block');
    for (const id of inherited) {
      const root = roots.get(id);
      const row = byId.get(id);
      if (!row) reject('source block lineage is missing');
      const issues = new Set(root?.issues ?? []);
      if (selectedMedia.length) issues.add('image_association');
      if (issues.has('missing_media')) reject(`block ${id} has unsaved source media`);
      for (const issue of issues) {
        const matches = confirmations
          .map((c, index) => ({ c, index }))
          .filter(
            ({ c }) =>
              c.block_id === id &&
              c.issue === issue &&
              c.content_sha256 === docxImportContentHash(block),
          );
        if (matches.length !== 1) reject(`block ${id}: unresolved ${issue}`);
        const { c, index } = matches[0];
        if (
          !integrity.input_sha256 ||
          c.source_sha256 !== integrity.input_sha256 ||
          integrity.markdown_sha256 !== sha256Hex(source.body_md ?? '') ||
          c.block_version !== row.version
        )
          reject(`block ${id}: stale source or block evidence`);
        const pageIndex = integrity.page_asset_ids.indexOf(c.page.asset_id);
        if (
          pageIndex < 0 ||
          !verifiedAsset(c.page) ||
          !block.page_spans.some(
            (span) =>
              span.page_index === pageIndex &&
              canonicalHash(span.bbox) === canonicalHash(c.page.region),
          )
        ) {
          reject(`block ${id}: unverified question region`);
        }
        const requiredMedia = new Set([...(root?.candidate_media_ids ?? []), ...selectedMedia]);
        if (
          c.media.length !== requiredMedia.size ||
          new Set(c.media.map((a) => a.asset_id)).size !== c.media.length ||
          c.media.some((a) => !requiredMedia.has(a.asset_id) || !verifiedAsset(a))
        ) {
          reject(`block ${id}: unverified media evidence`);
        }
        used.add(index);
      }
    }
  }
  if (used.size !== confirmations.length) reject('confirmation does not resolve a selected issue');
  if (integrity && used.size) {
    const updated: DocxIntegrityT = {
      ...integrity,
      confirmations: [
        ...integrity.confirmations,
        ...confirmations.map((c) => ({
          ...c,
          actor_ref: 'block_import' as const,
          confirmed_at: new Date().toISOString(),
        })),
      ],
    };
    await tx
      .update(source_document)
      .set({
        provenance: { ...source.provenance, docx_integrity: updated } as Record<string, unknown>,
        updated_at: new Date(),
        version: sql`${source_document.version} + 1`,
      })
      .where(eq(source_document.id, sourceDocumentId));
  }
  return true;
}

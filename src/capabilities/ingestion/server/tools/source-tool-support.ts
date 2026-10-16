import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { learning_session, source_asset, source_document } from '@/db/schema';

import { type R2Client, type SourceAssetRow, getR2 } from '../persist-image-asset';
import {
  type AssetRefInput,
  loadAssetBytesVerified,
  readSourcePackage,
  resolveAssetRef,
} from '../source-package';
import type { ToolContext } from './types';

// YUK-1404 (B2/R2) — shared plumbing for the ingestion media/source tools:
// versioned-ref resolution (digest-mismatch is an explicit error, never a
// latest-version fallback), ingestion-session scope enforcement, and
// digest-verified byte loads.

export const AssetRefInputSchema = z.union([
  z.string().min(1),
  z.object({ asset_id: z.string().min(1), digest: z.string().min(1) }),
]);

export const PixelBBoxInputSchema = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().gt(0),
  height: z.number().finite().gt(0),
});
export type PixelBBoxInput = z.infer<typeof PixelBBoxInputSchema>;

/** Resolve a ref to its row or throw an error the bridge surfaces verbatim. */
export async function requireAssetRef(
  ctx: ToolContext,
  ref: AssetRefInput,
): Promise<SourceAssetRow> {
  const resolved = await resolveAssetRef(ctx.db, ref);
  if (resolved.status !== 'ok') {
    throw new Error(`${resolved.status}: ${resolved.detail}`);
  }
  return resolved.row;
}

/** The asset ids an ingestion session's package legitimately covers. */
async function scopedAssetIds(db: Db, sessionId: string): Promise<Set<string> | null> {
  const [session] = await db
    .select({ source_document_id: learning_session.source_document_id })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  const docId = session?.source_document_id;
  if (!docId) return null;
  const [doc] = await db
    .select({
      source_asset_ids: source_document.source_asset_ids,
      provenance: source_document.provenance,
    })
    .from(source_document)
    .where(eq(source_document.id, docId))
    .limit(1);
  if (!doc) return null;
  const ids = new Set(doc.source_asset_ids);
  const pkg = readSourcePackage(doc.provenance);
  if (pkg) {
    for (const f of pkg.files) ids.add(f.asset_id);
  }
  return ids;
}

/**
 * Ingestion tools are granted on ONE surface, which binds
 * ctx.scope={kind:'ingestion_session', id}. An absent/foreign scope fails
 * CLOSED — there is no sanctioned unscoped caller.
 */
export function requireIngestionScope(ctx: ToolContext): string {
  const scope = ctx.scope;
  if (scope?.kind !== 'ingestion_session' || !scope.id) {
    throw new Error(
      "this tool requires an ingestion_session scope (ctx.scope={kind:'ingestion_session',id}); absent scope fails closed",
    );
  }
  return scope.id;
}

/**
 * Scope enforcement (inventory §5.1.3): an asset is in scope iff it is a
 * package member or a derived asset whose derived_from chain reaches one (≤6
 * hops). A scope that resolves to no session/document fails CLOSED.
 */
export async function assertAssetInScope(ctx: ToolContext, assetId: string): Promise<void> {
  const scopeId = requireIngestionScope(ctx);
  const ids = await scopedAssetIds(ctx.db, scopeId);
  if (ids === null) {
    throw new Error(`ingestion_session '${scopeId}' has no resolvable source package`);
  }

  let current = assetId;
  for (let hop = 0; hop < 6; hop++) {
    if (ids.has(current)) return;
    const [row] = await ctx.db
      .select({ provenance: source_asset.provenance })
      .from(source_asset)
      .where(eq(source_asset.id, current))
      .limit(1);
    const parent = (row?.provenance as Record<string, unknown> | undefined)?.derived_from as
      | { asset_id?: unknown }
      | undefined;
    if (typeof parent?.asset_id !== 'string' || parent.asset_id === current) {
      break;
    }
    current = parent.asset_id;
  }
  throw new Error(`asset '${assetId}' is outside ingestion_session '${scopeId}'`);
}

/** Load asset bytes from object storage with the sha256 re-verified. */
export async function loadVerifiedAssetBytes(
  r2: R2Client,
  row: SourceAssetRow,
): Promise<Uint8Array> {
  return loadAssetBytesVerified(r2, row);
}

/**
 * The source_document that owns this asset. Codex 4293474471 — embedded
 * package media and crop/rotate-derived assets are not in
 * `source_asset_ids`, so the flat membership query reported null. Resolve the
 * way assertAssetInScope does: package membership + derived_from lineage
 * back to a package member, then the scoped session's document. Falls back to
 * the flat membership query for callers outside an ingestion scope.
 */
export async function findOwningDocument(
  ctx: ToolContext,
  assetId: string,
): Promise<string | null> {
  const scopeId = ctx.scope?.kind === 'ingestion_session' ? ctx.scope.id : null;
  if (scopeId) {
    const ids = await scopedAssetIds(ctx.db, scopeId);
    if (ids) {
      let current = assetId;
      for (let hop = 0; hop < 6; hop++) {
        if (ids.has(current)) {
          const [session] = await ctx.db
            .select({ source_document_id: learning_session.source_document_id })
            .from(learning_session)
            .where(eq(learning_session.id, scopeId))
            .limit(1);
          return session?.source_document_id ?? null;
        }
        const [row] = await ctx.db
          .select({ provenance: source_asset.provenance })
          .from(source_asset)
          .where(eq(source_asset.id, current))
          .limit(1);
        const parent = (row?.provenance as Record<string, unknown> | undefined)?.derived_from as
          | { asset_id?: unknown }
          | undefined;
        if (typeof parent?.asset_id !== 'string' || parent.asset_id === current) break;
        current = parent.asset_id;
      }
    }
  }
  const rows = await ctx.db
    .select({ id: source_document.id })
    .from(source_document)
    .where(sql`${source_document.source_asset_ids}::jsonb ? ${assetId}`)
    .limit(1);
  return rows[0]?.id ?? null;
}

export { getR2 };

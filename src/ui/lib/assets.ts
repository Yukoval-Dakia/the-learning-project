// Phase 1c.2 Vision MVP — asset upload + cached thumbnail helpers.
// YUK-1051 (D10) — read path generalized beyond images: the same apiFetch + blob +
// objectURL flow now also carries the response Content-Type so callers can pick the
// right renderer (image inline / audio+video native controls / PDF download-only /
// text escaped). No signed URLs are invented; auth stays header-based (preflight §10).
//
// /api/assets needs the x-internal-token header, so plain `<img src="/api/assets/.../content">`
// won't work — the browser can't attach custom headers to <img> requests.
// The UI fetches bytes via apiFetch, wraps them in a Blob, and renders the
// resulting object URL.

import { useEffect, useState } from 'react';
import { apiFetch } from './api';

export interface UploadedAsset {
  id: string;
  storage_key: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
}

export async function uploadAsset(file: File): Promise<UploadedAsset> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch('/api/assets', { method: 'POST', body: form });
  // /api/assets returns `{ asset: row }` (route.ts), so unwrap `.asset` — the
  // previous flat cast left every `.id` undefined, which broke POST
  // /api/ingestion (asset_ids: [undefined]). Pre-existing prod bug fixed under
  // YUK-250; regression-tested in assets.test.ts.
  const body = (await res.json()) as { asset: UploadedAsset };
  return body.asset;
}

export interface ExpandedPdf {
  asset_ids: string[];
  page_count: number;
}

// Single-PDF → N page-image assets. POST /api/ingestion/pdf renders the PDF
// server-side and persists one content-addressed image asset per page,
// returning a FLAT `{ asset_ids, page_count }` shape (NOT wrapped in `{asset}` —
// do not conflate with uploadAsset). The caller feeds asset_ids straight into
// POST /api/ingestion, identical to the photo path.
export async function expandPdf(file: File): Promise<ExpandedPdf> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch('/api/ingestion/pdf', { method: 'POST', body: form });
  return (await res.json()) as ExpandedPdf;
}

// YUK-258 — DOCX ingestion. POST /api/ingestion/docx is SELF-CONTAINED: it
// classifies the .docx (text vs visual line), builds the session server-side
// (text line lands blocks directly in 'extracted'; visual line enqueues
// tencent_ocr_extract), and returns the session id. Unlike expandPdf (which only
// expands assets and leaves session-create to the caller), the caller here does
// NOT then POST /api/ingestion — the session already exists.
export interface DocxIngested {
  session_id: string;
  line: 'text' | 'visual';
  page_count: number;
}

export async function expandDocx(file: File): Promise<DocxIngested> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch('/api/ingestion/docx', { method: 'POST', body: form });
  return (await res.json()) as DocxIngested;
}

// In-memory cache so the same asset id rendered in multiple BlockEditors
// shares one fetch + one object URL.
const urlCache = new Map<string, string>();
// YUK-1051 — parallel cache for the Content-Type seen on the same response.
// Populated by fetchAssetObject; image-only legacy callers of fetchAssetObjectUrl
// simply ignore it.
const mimeCache = new Map<string, string>();
const pendingFetches = new Map<string, Promise<string>>();

export async function fetchAssetObjectUrl(id: string): Promise<string> {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const inflight = pendingFetches.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    const res = await apiFetch(`/api/assets/${id}/content`);
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    urlCache.set(id, url);
    if (mimeType) mimeCache.set(id, mimeType);
    return url;
  })();
  pendingFetches.set(id, p);
  try {
    return await p;
  } finally {
    pendingFetches.delete(id);
  }
}

export interface AssetObject {
  url: string;
  /** Content-Type as served (normalized, no parameters); null when the server omits it. */
  mimeType: string | null;
}

/**
 * YUK-1051 — mime-aware variant of fetchAssetObjectUrl. Shares the same caches, so an
 * asset already fetched as a bare URL is not refetched; the mime is recovered from the
 * parallel cache when available (a legacy first fetch may have missed it → mimeType null,
 * callers degrade conservatively to a download chip).
 */
export async function fetchAssetObject(id: string): Promise<AssetObject> {
  const cached = urlCache.get(id);
  if (cached) return { url: cached, mimeType: mimeCache.get(id) ?? null };
  const res = await apiFetch(`/api/assets/${id}/content`);
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  if (mimeType) mimeCache.set(id, mimeType);
  return { url, mimeType };
}

/** Synchronous cache peek — lets a renderer avoid a loading flash for known assets. */
export function peekAssetObject(id: string): AssetObject | null {
  const url = urlCache.get(id);
  return url ? { url, mimeType: mimeCache.get(id) ?? null } : null;
}

/**
 * Resolves an asset id to a blob: URL the browser can use as <img src>.
 * Cached across components — same id never refetches.
 */
export function useAssetUrl(assetId: string | null | undefined): {
  url: string | null;
  loading: boolean;
  error: Error | null;
} {
  const [url, setUrl] = useState<string | null>(() =>
    assetId ? (urlCache.get(assetId) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!assetId) {
      setUrl(null);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = urlCache.get(assetId);
    if (cached) {
      setUrl(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAssetObjectUrl(assetId)
      .then((u) => {
        if (cancelled) return;
        setUrl(u);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err as Error);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  return { url, loading, error };
}

// Phase 1c.2 Vision MVP — asset upload + cached thumbnail helpers.
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

// In-memory cache so the same asset id rendered in multiple BlockEditors
// shares one fetch + one object URL.
const urlCache = new Map<string, string>();
const pendingFetches = new Map<string, Promise<string>>();

export async function fetchAssetObjectUrl(id: string): Promise<string> {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const inflight = pendingFetches.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    const res = await apiFetch(`/api/assets/${id}/content`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    urlCache.set(id, url);
    return url;
  })();
  pendingFetches.set(id, p);
  try {
    return await p;
  } finally {
    pendingFetches.delete(id);
  }
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

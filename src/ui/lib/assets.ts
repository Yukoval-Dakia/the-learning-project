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

import { useCallback, useSyncExternalStore } from 'react';
import { ApiError, apiFetch, subscribeAuthInvalidation } from './api';

export interface UploadedAsset {
  id: string;
  storage_key: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  /** Original asset-row timestamp, available on server upload receipts. */
  created_at?: string;
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

// A rejected .docx comes back as a 4xx whose message names internal package parts
// (e.g. word/_rels/footer1.xml.rels). Learners get plain words instead; a typed
// reason from the server can refine this later (YUK-1476).
const DOCX_REJECTED_MESSAGE = '这份 Word 文件暂时导不进来。可以把它另存为 PDF 再上传。';

export async function expandDocx(file: File): Promise<DocxIngested> {
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await apiFetch('/api/ingestion/docx', { method: 'POST', body: form });
    return (await res.json()) as DocxIngested;
  } catch (err) {
    if (err instanceof ApiError && [400, 413, 415, 422].includes(err.status)) {
      throw new Error(DOCX_REJECTED_MESSAGE, { cause: err });
    }
    throw err;
  }
}

// Asset object-URL owner (YUK-1483). One entry per asset id + auth epoch owns the in-flight
// read and the blob: URL it produces, so every consumer of the same asset shares one request
// and one URL. React consumers hold the entry through useSyncExternalStore subscriptions: the
// URL is revoked (or the read aborted) only after the last subscriber leaves. Imperative callers
// (fetchAssetObject / fetchAssetObjectUrl / peekAssetObject) cannot tell us when they are done,
// so an entry they touched is pinned and kept, as before. Losing auth bumps the epoch and drops
// every entry, so an old token's bytes are never shown again.
//
// Entries are only created on the client (subscriptions and the imperative fetches never run
// during SSR), so these module maps hold no per-request server state.

export interface AssetObject {
  url: string;
  /** Content-Type as served (normalized, no parameters); null when the server omits it. */
  mimeType: string | null;
}

/** Cached, read-only view of one asset for React consumers. */
export interface AssetObjectState {
  url: string | null;
  mimeType: string | null;
  loading: boolean;
  error: Error | null;
}

interface AssetEntry {
  key: string;
  id: string;
  /** Live useSyncExternalStore subscriptions. */
  refs: number;
  /** Handed out to an imperative caller; never revoked except on auth loss. */
  pinned: boolean;
  snapshot: AssetObjectState;
  pending: Promise<AssetObject> | null;
  abort: AbortController | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
}

const NO_ASSET: AssetObjectState = Object.freeze({
  url: null,
  mimeType: null,
  loading: false,
  error: null,
});
const ASSET_LOADING: AssetObjectState = Object.freeze({
  url: null,
  mimeType: null,
  loading: true,
  error: null,
});

const entries = new Map<string, AssetEntry>();
let authEpoch = 0;
let authWatchStarted = false;
const epochListeners = new Set<() => void>();

function entryKey(epoch: number, id: string): string {
  return `${epoch}\u0000${id}`;
}

function dropAllEntries(): void {
  authEpoch += 1;
  for (const entry of entries.values()) {
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
    entry.abort?.abort();
    if (entry.snapshot.url) URL.revokeObjectURL(entry.snapshot.url);
  }
  entries.clear();
  for (const listener of epochListeners) listener();
}

function ensureAuthWatch(): void {
  if (authWatchStarted) return;
  authWatchStarted = true;
  // Lives as long as the asset cache itself (module lifetime, client only).
  subscribeAuthInvalidation(dropAllEntries);
}

function getOrCreateEntry(id: string): AssetEntry {
  ensureAuthWatch();
  const key = entryKey(authEpoch, id);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      id,
      refs: 0,
      pinned: false,
      snapshot: ASSET_LOADING,
      pending: null,
      abort: null,
      releaseTimer: null,
      listeners: new Set(),
    };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: AssetEntry, snapshot: AssetObjectState): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function isLive(entry: AssetEntry): boolean {
  return entries.get(entry.key) === entry && (entry.refs > 0 || entry.pinned);
}

function startRead(entry: AssetEntry): Promise<AssetObject> {
  const abort = new AbortController();
  entry.abort = abort;
  const read = (async (): Promise<AssetObject> => {
    const res = await apiFetch(`/api/assets/${entry.id}/content`, { signal: abort.signal });
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
    const blob = await res.blob();
    return { url: URL.createObjectURL(blob), mimeType };
  })();
  entry.pending = read;
  if (entry.snapshot !== ASSET_LOADING) publish(entry, ASSET_LOADING);
  read.then(
    (obj) => {
      entry.pending = null;
      entry.abort = null;
      if (!isLive(entry)) {
        // Every consumer left (or auth was lost) while the bytes were in flight.
        URL.revokeObjectURL(obj.url);
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        return;
      }
      publish(entry, { url: obj.url, mimeType: obj.mimeType, loading: false, error: null });
    },
    (err: unknown) => {
      entry.pending = null;
      entry.abort = null;
      if (!isLive(entry)) {
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        return;
      }
      publish(entry, {
        url: null,
        mimeType: null,
        loading: false,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    },
  );
  return read;
}

function readEntry(entry: AssetEntry): Promise<AssetObject> {
  const { url, mimeType } = entry.snapshot;
  if (url) return Promise.resolve({ url, mimeType });
  return entry.pending ?? startRead(entry);
}

function releaseEntry(entry: AssetEntry): void {
  entry.releaseTimer = null;
  if (entry.refs > 0 || entry.pinned || entries.get(entry.key) !== entry) return;
  entries.delete(entry.key);
  entry.abort?.abort();
  if (entry.snapshot.url) URL.revokeObjectURL(entry.snapshot.url);
}

function acquireEntry(epoch: number, id: string, listener: () => void): () => void {
  // A render from before an auth change: its epoch listener re-renders it with the new epoch.
  if (epoch !== authEpoch) return () => {};
  const entry = getOrCreateEntry(id);
  entry.refs += 1;
  entry.listeners.add(listener);
  if (entry.releaseTimer) {
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = null;
  }
  // First subscriber starts the read; a later mount retries a failed one.
  if (!entry.snapshot.url && !entry.pending) {
    void startRead(entry).catch(() => {
      // Surfaced through the entry snapshot.
    });
  }
  return () => {
    entry.listeners.delete(listener);
    entry.refs -= 1;
    if (entry.refs === 0 && !entry.pinned && !entry.releaseTimer) {
      // Wait one task: when one consumer unmounts as another mounts the same asset in the
      // same commit, the newcomer subscribes before this fires and keeps the URL alive.
      entry.releaseTimer = setTimeout(() => releaseEntry(entry), 0);
    }
  };
}

function subscribeAuthEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
}

function getAuthEpoch(): number {
  return authEpoch;
}

function getServerAuthEpoch(): number {
  return 0;
}

function getServerAssetState(): AssetObjectState {
  return NO_ASSET;
}

export async function fetchAssetObjectUrl(id: string): Promise<string> {
  return (await fetchAssetObject(id)).url;
}

/**
 * YUK-1051 — mime-aware variant of fetchAssetObjectUrl. Shares the same entry (and the same
 * in-flight read), so an asset already fetched as a bare URL is not refetched.
 */
export function fetchAssetObject(id: string): Promise<AssetObject> {
  const entry = getOrCreateEntry(id);
  entry.pinned = true;
  return readEntry(entry);
}

/** Synchronous cache peek — lets a renderer avoid a loading flash for known assets. */
export function peekAssetObject(id: string): AssetObject | null {
  const entry = entries.get(entryKey(authEpoch, id));
  if (!entry?.snapshot.url) return null;
  entry.pinned = true;
  return { url: entry.snapshot.url, mimeType: entry.snapshot.mimeType };
}

/**
 * Subscribes to one asset's shared object URL and MIME. Reading starts when the first
 * consumer subscribes; the URL stays valid while any consumer is subscribed.
 */
export function useAssetObject(assetId: string | null | undefined): AssetObjectState {
  const epoch = useSyncExternalStore(subscribeAuthEpoch, getAuthEpoch, getServerAuthEpoch);
  const id = assetId || null;
  const subscribe = useCallback(
    (listener: () => void) => (id ? acquireEntry(epoch, id, listener) : () => {}),
    [id, epoch],
  );
  const getSnapshot = useCallback(
    () => (id ? (entries.get(entryKey(epoch, id))?.snapshot ?? ASSET_LOADING) : NO_ASSET),
    [id, epoch],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerAssetState);
}

/**
 * Resolves an asset id to a blob: URL the browser can use as <img src>.
 * Shared across components — same id never refetches while any consumer holds it.
 */
export function useAssetUrl(assetId: string | null | undefined): {
  url: string | null;
  loading: boolean;
  error: Error | null;
} {
  const { url, loading, error } = useAssetObject(assetId);
  return { url, loading, error };
}

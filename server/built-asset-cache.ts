// Cache and encoding for built Start files under /_build/*.
// A content hash in the URL is the only signal that the bytes will not change
// at that path. js/css are precompressed; serveStatic matches Accept-Encoding
// tokens literally and prefers br over gzip, so the choice is made here.

import type { MiddlewareHandler } from 'hono';

export const IMMUTABLE_ASSET_CACHE = 'public, max-age=31536000, immutable';

export const builtAssetEncodings = ['br', 'gzip'] as const;
export type BuiltAssetEncoding = (typeof builtAssetEncodings)[number];
export type NegotiatedEncoding = BuiltAssetEncoding | 'identity';

export type BuiltAssetPlan = {
  readonly cache: 'immutable' | 'unspecified';
  readonly encodings: readonly BuiltAssetEncoding[];
};

const CONTENT_HASHED_ASSET = /\/assets\/(?:[^/]+\/)*[^/]+-([A-Za-z0-9_-]{8,})(?:\.[A-Za-z0-9]+)+$/;
const TEXT_ASSET = /\.(?:js|css)$/i;
const SUCCESS_STATUS = new Set([200, 206]);

function generatedHash(pathname: string): boolean {
  const hash = CONTENT_HASHED_ASSET.exec(pathname)?.[1];
  if (hash === undefined) return false;
  return /\d/.test(hash) || (/[a-z]/.test(hash) && /[A-Z]/.test(hash));
}

export function planBuiltAsset(pathname: string): BuiltAssetPlan {
  return {
    cache: generatedHash(pathname) ? 'immutable' : 'unspecified',
    encodings: TEXT_ASSET.test(pathname) ? builtAssetEncodings : [],
  };
}

function acceptQualities(header: string): Map<string, number> {
  const qualities = new Map<string, number>();
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const param of params) {
      const eq = param.indexOf('=');
      if (eq === -1 || param.slice(0, eq).trim() !== 'q') continue;
      const parsed = Number(param.slice(eq + 1).trim());
      quality = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    }
    qualities.set(name, quality);
  }
  return qualities;
}

// Offered order is the tie-break: br, then gzip. A missing header stays identity
// so a client that did not ask for compression still receives the raw file.
export function negotiateEncoding(
  acceptEncoding: string | null,
  offered: readonly BuiltAssetEncoding[],
): NegotiatedEncoding {
  if (acceptEncoding === null || offered.length === 0) return 'identity';
  const qualities = acceptQualities(acceptEncoding);
  const wildcard = qualities.get('*');
  let winner: BuiltAssetEncoding | undefined;
  let winnerQuality = 0;
  for (const encoding of offered) {
    const quality = qualities.get(encoding) ?? wildcard ?? 0;
    if (quality > winnerQuality) {
      winner = encoding;
      winnerQuality = quality;
    }
  }
  return winner ?? 'identity';
}

function varyAlreadyListsEncoding(vary: string | undefined): boolean {
  return vary?.split(',').some((part) => part.trim().toLowerCase() === 'accept-encoding') ?? false;
}

export function builtAssetEncoding(): MiddlewareHandler {
  return async (c, next) => {
    const plan = planBuiltAsset(c.req.path);
    const header = c.req.raw.headers.get('Accept-Encoding');
    const encoding = negotiateEncoding(header, plan.encodings);
    // A Fetch request guard treats Accept-Encoding as forbidden and throws on
    // set. The original tokens still match what browsers send (`br`, `gzip`).
    if (header !== null) {
      try {
        c.req.raw.headers.set('Accept-Encoding', encoding);
      } catch {
        // keep the incoming header
      }
    }
    await next();
    if (!SUCCESS_STATUS.has(c.res.status)) return;
    if (plan.cache === 'immutable') c.header('Cache-Control', IMMUTABLE_ASSET_CACHE);
    const vary = c.res.headers.get('Vary') ?? undefined;
    if (plan.encodings.length > 0 && !varyAlreadyListsEncoding(vary)) {
      c.header('Vary', 'Accept-Encoding', { append: true });
    }
  };
}

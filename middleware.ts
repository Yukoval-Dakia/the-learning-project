import { type NextRequest, NextResponse } from 'next/server';

const encoder = new TextEncoder();

/** SHA-256 digest of `value` as a fixed 32-byte array (Web Crypto, edge-safe). */
async function sha256(value: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
  return new Uint8Array(digest);
}

/**
 * Constant-time comparison of `provided` against `secret`.
 *
 * Both inputs are hashed to fixed 32-byte SHA-256 digests first, so the XOR
 * compare loop always runs over equal-length buffers — length is normalized by
 * construction and the comparison leaks no timing information about either the
 * length or the content of the secret. Returns false when `secret` is undefined
 * so an unset INTERNAL_TOKEN rejects every request, matching prior behaviour.
 */
async function timingSafeEqualToken(
  provided: string,
  secret: string | undefined,
): Promise<boolean> {
  if (secret === undefined) return false;
  const [a, b] = await Promise.all([sha256(provided), sha256(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function middleware(req: NextRequest): Promise<NextResponse | undefined> {
  const path = req.nextUrl.pathname;
  // Uptime monitors hit /api/health without credentials; explicitly exempt.
  if (path === '/api/health') return;
  const token = req.headers.get('x-internal-token');
  if (!token || !(await timingSafeEqualToken(token, process.env.INTERNAL_TOKEN))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
}

export const config = { matcher: '/api/:path*' };

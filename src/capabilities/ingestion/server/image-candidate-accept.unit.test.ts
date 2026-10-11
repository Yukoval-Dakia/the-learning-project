// YUK-1404 — security invariant: every source-fetch failure serialized to the client
// must be free of the raw host / resolved IP / full source URL. The proposal source_url
// is AI-written (TEST evidence: real jyeoo /shiti/{id} PAGE links) and can embed
// third-party + internal topology, so the pre-YUK-1404 messages that interpolated
// `${bareHost}` / `${invalid.address}` / `${url}` leaked it through errorResponse().
// The typed `details.reason` + `next_step` vocabulary is the UI mapping contract, and
// ApiError codes + HTTP statuses must keep their pre-YUK-1404 values (400 for
// validation_error, 422 for extraction_failed / unsupported_media_type) so existing
// consumers do not drift. Guard behavior itself (blocking, pinning, caps) is asserted
// indirectly: the same rejection sites still throw with the same statuses.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse } from '@/kernel/http';
import {
  assertPublicHttpUrl,
  defaultFetchImageBytes,
  resolvePublicAddresses,
} from './image-candidate-accept';
import { fetchWithPinnedDispatcher } from './pinned-fetch';

vi.mock('./pinned-fetch', () => ({
  // Offline transport seam: the accept path's fetch is replaced wholesale, mirroring the
  // DB-test mock pattern (proposal-appliers.db.test.ts) so no test here touches network.
  fetchWithPinnedDispatcher: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithPinnedDispatcher);

interface SerializedApiError {
  error: string;
  message?: string;
  details?: { reason?: unknown; next_step?: unknown };
}

async function capture(fn: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the guarded call to throw');
}

/** Serialize a thrown error exactly as the API would (kernel errorResponse). */
async function serialize(err: unknown): Promise<{ body: SerializedApiError; wire: string }> {
  const res = errorResponse(err);
  const body = (await res.json()) as SerializedApiError;
  return { body, wire: JSON.stringify(body) };
}

// resolvePublicAddresses awaits a node:dns/promises-style (promise-returning) lookup,
// not the callback-style node:net LookupFunction — the fake must match that shape.
type DnsLookupFn = typeof import('node:dns/promises')['lookup'];
function dnsLookup(
  impl: (host: string) => Promise<Array<{ address: string; family: number }>>,
): DnsLookupFn {
  return ((host: string) => impl(host)) as unknown as DnsLookupFn;
}

const PUBLIC_ANSWERS = [{ address: '115.231.191.194', family: 4 }];

beforeEach(() => {
  fetchMock.mockReset();
});

describe('YUK-1404 learner-safe source-fetch failures', () => {
  // @invariant security: private-host address failures never disclose source or network details in client responses.
  // @fails-if the client response echoes the rejected literal private address.
  it('blocked literal private host → 400 validation_error, reason source_host_nonpublic, no host leak', async () => {
    const err = await capture(() => assertPublicHttpUrl('http://192.168.1.10/a.png'));
    const { body, wire } = await serialize(err);
    expect(body.error).toBe('validation_error');
    expect(body.details?.reason).toBe('source_host_nonpublic');
    expect(body.details?.next_step).toBe('replace_source_url');
    expect(wire).not.toContain('192.168.1.10');
  });

  // @invariant security: fake-IP DNS resolution failures never disclose source or network details in client responses.
  // @fails-if the client response echoes the resolved fake IP or source host.
  it('fake-IP DNS answer (198.18.0.0/15, the incident shape) → 400, reason source_host_nonpublic, no host/IP leak', async () => {
    const lookup = dnsLookup(async () => [{ address: '198.18.12.228', family: 4 }]);
    const err = await capture(() =>
      resolvePublicAddresses(new URL('https://www.jyeoo.com/shiti/abc'), lookup),
    );
    const { body, wire } = await serialize(err);
    expect(body.error).toBe('validation_error');
    expect(body.details?.reason).toBe('source_host_nonpublic');
    expect(wire).not.toContain('198.18.12.228');
    expect(wire).not.toContain('www.jyeoo.com');
  });

  // @invariant security: DNS exception failures never disclose source or network details in client responses.
  // @fails-if the client response exposes a hostname embedded in the DNS exception.
  it('DNS lookup failure (node:dns error embeds the host) → 422 extraction_failed, reason source_dns_lookup_failed, no host leak', async () => {
    const lookup = dnsLookup(async (host) => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    });
    const err = await capture(() =>
      resolvePublicAddresses(new URL('https://secret-host.internal.example/a.png'), lookup),
    );
    const { body, wire } = await serialize(err);
    expect(body.error).toBe('extraction_failed');
    expect(body.details?.reason).toBe('source_dns_lookup_failed');
    expect(body.details?.next_step).toBe('retry_accept');
    expect(wire).not.toContain('secret-host.internal.example');
  });

  // @invariant security: empty DNS resolution failures never disclose source or network details in client responses.
  // @fails-if the client response exposes the source hostname when no DNS addresses exist.
  it('empty DNS answer set → 422 extraction_failed, reason source_dns_no_addresses, no host leak', async () => {
    const lookup = dnsLookup(async () => []);
    const err = await capture(() =>
      resolvePublicAddresses(new URL('https://www.jyeoo.com/shiti/abc'), lookup),
    );
    const { body, wire } = await serialize(err);
    expect(body.error).toBe('extraction_failed');
    expect(body.details?.reason).toBe('source_dns_no_addresses');
    expect(body.details?.next_step).toBe('replace_source_url');
    expect(wire).not.toContain('www.jyeoo.com');
  });

  // @invariant security: non-image source response failures never disclose source or network details in client responses.
  // @fails-if the client response exposes the rejected page URL or source hostname.
  it('non-image Content-Type (the /shiti/{id} page-URL shape) → 422 unsupported_media_type, reason source_not_an_image, no URL leak', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }) as unknown as Awaited<ReturnType<typeof fetchWithPinnedDispatcher>>,
    );
    const err = await capture(() =>
      defaultFetchImageBytes(
        'https://www.jyeoo.com/shiti/c99a10ab',
        dnsLookup(async () => PUBLIC_ANSWERS),
      ),
    );
    const { body, wire } = await serialize(err);
    expect(body.error).toBe('unsupported_media_type');
    expect(body.details?.reason).toBe('source_not_an_image');
    expect(body.details?.next_step).toBe('replace_source_url');
    expect(wire).not.toContain('www.jyeoo.com');
    expect(wire).not.toContain('/shiti/');
  });

  // @invariant security: transport exception failures never disclose source or network details in client responses.
  // @fails-if the client response forwards the transport exception containing the source URL.
  it('transport-level fetch rejection → 422 extraction_failed, reason source_fetch_failed (was a raw 500), no URL leak', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err = await capture(() =>
      defaultFetchImageBytes(
        'https://www.jyeoo.com/shiti/c99a10ab',
        dnsLookup(async () => PUBLIC_ANSWERS),
      ),
    );
    const { body, wire } = await serialize(err);
    expect(body.error).toBe('extraction_failed');
    expect(body.details?.reason).toBe('source_fetch_failed');
    expect(body.details?.next_step).toBe('retry_accept');
    expect(wire).not.toContain('www.jyeoo.com');
    expect(wire).not.toContain('/shiti/');
  });

  // @invariant security: upstream HTTP failure failures never disclose source or network details in client responses.
  // @fails-if the client response exposes the failing upstream URL or source hostname.
  it('HTTP error status → 422 extraction_failed, reason source_fetch_failed, no URL leak', async () => {
    fetchMock.mockResolvedValue(
      new Response('nope', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }) as unknown as Awaited<ReturnType<typeof fetchWithPinnedDispatcher>>,
    );
    const err = await capture(() =>
      defaultFetchImageBytes(
        'https://www.jyeoo.com/shiti/c99a10ab',
        dnsLookup(async () => PUBLIC_ANSWERS),
      ),
    );
    const { body, wire } = await serialize(err);
    expect(body.error).toBe('extraction_failed');
    expect(body.details?.reason).toBe('source_fetch_failed');
    expect(wire).not.toContain('www.jyeoo.com');
  });

  // @invariant security: invalid source URL failures never disclose source or network details in client responses.
  // @fails-if the client response echoes raw malformed source input.
  it('unparseable source_url → 400 validation_error with a fixed message (no raw URL echo)', async () => {
    const err = await capture(() => assertPublicHttpUrl('http://x:not-a-url{oops}'));
    const { body, wire } = await serialize(err);
    expect(body.error).toBe('validation_error');
    expect(body.message).not.toContain('not-a-url');
    expect(wire).not.toContain('oops');
  });
});

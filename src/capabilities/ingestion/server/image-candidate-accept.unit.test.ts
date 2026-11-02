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
import { describe, expect, it } from 'vitest';
import { errorResponse } from '@/kernel/http';
import { resolvePublicAddresses } from './image-candidate-accept';

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

describe('YUK-1404 learner-safe source-fetch failures', () => {
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
});

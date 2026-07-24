// YUK-229 / YUK-688 — shared, browser-safe SSRF host-literal guard. Extracted from the
// image_candidate accept path (src/capabilities/ingestion/server/image-candidate-accept.ts)
// so the client can apply the SAME protocol + literal-host checks BEFORE ever pointing a
// browser <img> at an AI-written source_url, and the server keeps a single source of truth.
//
// SCOPE (what this module can and cannot do):
//   ✅ Reject non-http(s) protocols, embedded credentials, and literal private / loopback /
//      link-local / unique-local / NAT64-mapped hosts written directly in the URL.
//   ❌ DNS-based SSRF (a public hostname whose A/AAAA answer points inside the network) and
//      DNS-rebinding are NOT defendable in the browser — the server owns those via DNS-answer
//      + redirect re-validation. The client's second line of defence is to never auto-load the
//      image (user must click to reveal), demoting passive probes to explicit actions.
//
// Pure (no IO, no node built-ins): `new URL` is available in both the SPA and Node, and IP
// family detection is a hand-rolled parser rather than `node:net.isIP` so `@/core` stays
// import-safe from the browser.

// IANA special-purpose / private / loopback / link-local IPv4 ranges that must never be a
// fetch/image target. Kept verbatim from the server guard so the two ends cannot drift.
export const BLOCKED_IPV4_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;

export function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

// Self-validating IPv4 parse (returns the 32-bit value, or null when the string is not a
// dotted-quad literal). Deliberately treats leading-zero octets as their decimal value so a
// form like 192.168.001.001 is classified as an IP and blocked rather than slipping through
// as a hostname a browser might still resolve to that private address.
function parseIpv4Value(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function ipv4InCidr(value: number, base: string, prefix: number): boolean {
  const baseValue = parseIpv4Value(base);
  if (baseValue === null) return false;
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(value / blockSize) === Math.floor(baseValue / blockSize);
}

// Self-validating IPv6 parse into its 8 16-bit words (or null when not a valid IPv6 literal).
// A string with no colon is never IPv6 — this is what keeps hostnames such as `fdic.gov`
// (starts with the hex-looking `fd`) out of the IP path.
function parseIpv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (!normalized.includes(':')) return null;
  const dottedTail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const value = parseIpv4Value(dottedTail);
    if (value === null) return null;
    normalized = `${normalized.slice(0, -dottedTail.length)}${(value >>> 16).toString(16)}:${(
      value & 0xffff
    ).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const zeroCount = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (zeroCount < 0 || (halves.length === 1 && head.length !== 8)) return null;
  // Every explicit group must be 1-4 hex digits; this rejects over-long / non-hex segments
  // that Number.parseInt would otherwise coerce.
  if ([...head, ...tail].some((seg) => !/^[0-9a-f]{1,4}$/.test(seg))) return null;
  const words = [...head, ...Array.from({ length: zeroCount }, () => '0'), ...tail].map((word) =>
    Number.parseInt(word, 16),
  );
  return words.length === 8 && words.every((word) => Number.isInteger(word)) ? words : null;
}

/** IP family of a bare (bracket-stripped) host literal: 4, 6, or 0 when it is not an IP. */
export function ipFamily(host: string): 0 | 4 | 6 {
  if (parseIpv4Value(host) !== null) return 4;
  if (parseIpv6Words(host) !== null) return 6;
  return 0;
}

/**
 * True when the given IP literal is a non-public destination (loopback, private, link-local,
 * unique-local, multicast, or an IPv4 smuggled through IPv6 mapping / 6to4 / Teredo / NAT64).
 * Callers must pass an actual IP literal (ipFamily !== 0); a non-IP string is conservatively
 * treated as blocked.
 */
export function isBlockedIpAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.toLowerCase());
  const ipv4 = parseIpv4Value(normalized);
  if (ipv4 !== null) {
    return BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(ipv4, base, prefix));
  }

  const words = parseIpv6Words(normalized);
  if (!words) return true;
  // Block the two special IPv6 singletons explicitly and up front (YUK-229 review): `::`
  // (unspecified) and `::1` (loopback). Both would otherwise only be caught incidentally by the
  // IPv4-compatible interpretation below (as 0.0.0.0 / 0.0.0.1 in 0.0.0.0/8) — an explicit guard
  // states the intent and is robust to that branch changing.
  if (words.every((word) => word === 0)) return true; // :: unspecified
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true; // ::1 loopback
  const mappedIpv4 =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
      ? words[6] * 65_536 + words[7]
      : null;
  const compatibleIpv4 = words.slice(0, 6).every((word) => word === 0)
    ? words[6] * 65_536 + words[7]
    : null;
  if (mappedIpv4 !== null) {
    return BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(mappedIpv4, base, prefix));
  }
  if (compatibleIpv4 !== null) {
    return BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(compatibleIpv4, base, prefix));
  }

  // RFC 6052 well-known NAT64 prefix 64:ff9b::/96 embeds an IPv4 destination in the final 32
  // bits. Treat a mapped non-public IPv4 exactly like ::ffff:x.y.z.w; otherwise a NAT64-enabled
  // host could reach metadata/loopback through the WKP.
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    const nat64Ipv4 = words[6] * 65_536 + words[7];
    if (BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(nat64Ipv4, base, prefix))) {
      return true;
    }
  }

  return (
    (words[0] & 0xfe00) === 0xfc00 || // unique-local fc00::/7
    (words[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (words[0] & 0xff00) === 0xff00 || // multicast ff00::/8
    words[0] === 0x2002 || // deprecated 6to4 (embeds an IPv4 destination)
    (words[0] === 0x2001 && words[1] === 0) || // Teredo 2001:0000::/32
    (words[0] === 0x2001 && words[1] === 0x0db8) || // documentation 2001:db8::/32
    (words[0] === 0x0100 && words.slice(1, 4).every((word) => word === 0)) || // discard-only
    (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 1) // local-use NAT64
  );
}

/**
 * True when a URL hostname (possibly `[..]`-bracketed IPv6) is a literal that must never be a
 * fetch/image target: `localhost` / `*.localhost` / `*.local`, or a blocked IP literal. This is
 * the literal-host layer only — hostnames that resolve into the network via DNS are the
 * server's responsibility (DNS-answer + redirect re-validation).
 */
export function isBlockedHostLiteral(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const wasBracketed = lower.startsWith('[') && lower.endsWith(']');
  // Normalize before matching, none of which change which host is addressed but all of which can
  // dodge a naive literal check (YUK-229 review):
  //   - `[..]` IPv6 brackets;
  //   - a trailing FQDN dot (`localhost.` / `printer.local.` / `foo.localhost.`);
  //   - an IPv6 zone id (`fe80::1%eth0` / `%25eth0`) — everything from the first `%`.
  let bareHost = stripIpv6Brackets(lower).replace(/\.+$/, '');
  const zoneAt = bareHost.indexOf('%');
  if (zoneAt !== -1) bareHost = bareHost.slice(0, zoneAt);
  const family = ipFamily(bareHost);
  // Fail-closed: a bracketed literal is meant to be IPv6. If it does not parse as one (malformed,
  // or a zone form we could not normalize), refuse it rather than fall through to the hostname
  // branch where it would be treated as an ordinary — potentially allowed — name.
  if (wasBracketed && family !== 6) return true;
  const blockedName =
    bareHost === 'localhost' || bareHost.endsWith('.localhost') || bareHost.endsWith('.local');
  return blockedName || (family !== 0 && isBlockedIpAddress(bareHost));
}

/**
 * Browser-safe verdict for whether a URL is safe to point a passive <img>/fetch at as far as
 * static inspection can tell: valid URL, http(s), no embedded credentials, and not a blocked
 * literal host. Returns a boolean (never throws) so UI code can branch on it directly. The
 * server's `assertPublicHttpUrl` is the throwing counterpart and adds DNS-answer validation.
 */
export function isPublicHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !isBlockedHostLiteral(parsed.hostname);
}

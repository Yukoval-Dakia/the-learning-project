// Browser-safe SSRF guard for literal hosts, shared by client and server. It rejects
// non-http(s), embedded credentials, and private/loopback/link-local/mapped literals.
// DNS-based SSRF and rebinding are not defendable in the browser; the server validates
// DNS answers and redirects. Pure and browser-safe: no node built-ins, hand-rolled IP parsing.

// IANA special-purpose IPv4 ranges that must never be a fetch/image target.
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

// Canonical dotted-quad only; a leading-zero octet is rejected. This is load-bearing:
// inet_aton/glibc/WHATWG-URL read `012` as octal (10.0.0.1), so treating it as decimal
// would classify a private destination as public. Such hosts are failed closed below.
function parseIpv4Value(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
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

// IPv6 literal → 8 words, or null. Requiring a colon keeps hex-looking hostnames
// such as `fdic.gov` out of the IP path.
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
  // Reject over-long / non-hex groups that Number.parseInt would otherwise coerce.
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
 * Non-public IP literal (loopback, private, link-local, multicast, or IPv4 smuggled
 * through IPv6 mapping/6to4/Teredo/NAT64). Non-IP input is treated as blocked.
 */
export function isBlockedIpAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.toLowerCase());
  const ipv4 = parseIpv4Value(normalized);
  if (ipv4 !== null) {
    return BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(ipv4, base, prefix));
  }

  const words = parseIpv6Words(normalized);
  if (!words) return true;
  // Explicit `::` and `::1` guards, independent of the IPv4-compatible branch below.
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

  // NAT64 64:ff9b::/96 embeds IPv4 in the final 32 bits; block a private mapping before
  // it can reach metadata/loopback.
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

// inet_aton octet: decimal, hex (`0x7f`), or octal (`017`). Malformed numeric-looking
// tokens return null so the caller can fail closed.
function parseInetOctet(token: string): number | null {
  let value: number;
  if (/^0[xX][0-9a-f]+$/.test(token)) {
    value = Number.parseInt(token.slice(2), 16);
  } else if (/^0[0-7]+$/.test(token)) {
    value = Number.parseInt(token.slice(1), 8);
  } else if (token === '0') {
    value = 0;
  } else if (/^[1-9][0-9]*$/.test(token)) {
    value = Number.parseInt(token, 10);
  } else {
    return null;
  }
  return Number.isSafeInteger(value) ? value : null;
}

// Distinguishes numeric octet attempts from ordinary DNS labels such as `dead.beef`.
function isNumericToken(token: string): boolean {
  return /^(0[xX][0-9a-f]*|[0-9]+)$/.test(token);
}

// inet_aton semantics: the final token absorbs all remaining low-order bytes.
type InetResult = 'not-numeric' | 'invalid' | number;
function parseInetIpv4(host: string): InetResult {
  const parts = host.split('.');
  if (!parts.every(isNumericToken)) return 'not-numeric';
  if (parts.length === 0 || parts.length > 4) return 'invalid';
  const values: number[] = [];
  for (const token of parts) {
    const value = parseInetOctet(token);
    if (value === null) return 'invalid';
    values.push(value);
  }
  const last = values[values.length - 1];
  let addr = 0;
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] > 0xff) return 'invalid';
    addr = addr * 256 + values[i];
  }
  const remainingOctets = 4 - (values.length - 1);
  const lastMax = 2 ** (8 * remainingOctets) - 1;
  if (last > lastMax) return 'invalid';
  addr = addr * 2 ** (8 * remainingOctets) + last;
  return addr; // 0 .. 0xffffffff
}

function numberToDottedIpv4(addr: number): string {
  return [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff].join('.');
}

/**
 * Literal-host check: localhost/*.localhost/*.local or a blocked IP. DNS-resolved
 * destinations are the server's responsibility.
 */
export function isBlockedHostLiteral(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const wasBracketed = lower.startsWith('[') && lower.endsWith(']');
  // Normalize brackets, a trailing FQDN dot, and IPv6 zone ids; each can dodge a naive check.
  let bareHost = stripIpv6Brackets(lower).replace(/\.+$/, '');
  const zoneAt = bareHost.indexOf('%');
  if (zoneAt !== -1) bareHost = bareHost.slice(0, zoneAt);
  const family = ipFamily(bareHost);
  // A bracketed literal that is not valid IPv6 fails closed instead of falling through
  // to the hostname branch.
  if (wasBracketed && family !== 6) return true;
  const blockedName =
    bareHost === 'localhost' || bareHost.endsWith('.localhost') || bareHost.endsWith('.local');
  if (blockedName) return true;
  if (family !== 0) return isBlockedIpAddress(bareHost);
  // inet_aton forms (`2130706433`, `0x7f000001`, `127.1`, `012.0.0.1`) address an IPv4
  // that a dotted-quad check misses. Unparseable numeric-looking hosts fail closed.
  const numeric = parseInetIpv4(bareHost);
  if (numeric === 'not-numeric') return false;
  // Leading-zero octets are octal-ambiguous across parsers (`012` = 10.0.0.1 or 12.0.0.1),
  // so refuse the whole form. No legitimate public host uses one, and ordinary hostnames
  // never reach here. Hex is unambiguous and stays on the parse path.
  if (bareHost.split('.').some((token) => /^0[0-9]+$/.test(token))) return true;
  return numeric === 'invalid' ? true : isBlockedIpAddress(numberToDottedIpv4(numeric));
}

/**
 * Static browser-safe verdict: valid http(s) URL, no credentials, no blocked literal
 * host. Never throws; the server's assertPublicHttpUrl adds DNS validation.
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

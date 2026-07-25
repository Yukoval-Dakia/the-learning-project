// YUK-229 — parity + faithfulness pins for the shared SSRF host-literal guard extracted from
// the image_candidate accept path. These mirror the literal-host cases the server db test
// (proposal-appliers.db.test.ts) exercises, verifying the pure port matches node:net.isIP-based
// behavior without importing node built-ins.

import { describe, expect, it } from 'vitest';
import {
  ipFamily,
  isBlockedHostLiteral,
  isBlockedIpAddress,
  isPublicHttpUrl,
} from './private-host';

describe('ipFamily', () => {
  it('classifies IPv4 / IPv6 literals and treats hex-looking hostnames as non-IP', () => {
    expect(ipFamily('127.0.0.1')).toBe(4);
    expect(ipFamily('8.8.8.8')).toBe(4);
    expect(ipFamily('::1')).toBe(6);
    expect(ipFamily('fd00::1')).toBe(6);
    expect(ipFamily('::ffff:7f00:1')).toBe(6);
    expect(ipFamily('64:ff9b::a9fe:a9fe')).toBe(6);
    // Critical: fdic.gov starts with hex 'fd' but is a hostname, not IPv6.
    expect(ipFamily('fdic.gov')).toBe(0);
    expect(ipFamily('images.example.edu')).toBe(0);
    expect(ipFamily('12345::')).toBe(0); // segment > 4 hex digits is not valid IPv6
    expect(ipFamily('1.2.3.4.5')).toBe(0);
    expect(ipFamily('256.1.1.1')).toBe(0);
    // Leading-zero octets are not canonical dotted-quad (matches node:net.isIP, which returns 0
    // for all of these). They are octal under inet/WHATWG semantics and are handled by the
    // inet_aton branch of isBlockedHostLiteral instead.
    expect(ipFamily('012.0.0.1')).toBe(0);
    expect(ipFamily('0177.0.0.1')).toBe(0);
    expect(ipFamily('192.168.001.001')).toBe(0);
  });
});

describe('isBlockedIpAddress', () => {
  it('blocks loopback / private / link-local IPv4', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.10', '169.254.169.254']) {
      expect(isBlockedIpAddress(ip)).toBe(true);
    }
  });
  it('allows genuinely public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isBlockedIpAddress(ip)).toBe(false);
    }
  });
  it('blocks IPv6 loopback / unique-local / link-local and smuggled IPv4', () => {
    expect(isBlockedIpAddress('::1')).toBe(true);
    expect(isBlockedIpAddress('fd00::1')).toBe(true); // unique-local
    expect(isBlockedIpAddress('fe80::1')).toBe(true); // link-local
    expect(isBlockedIpAddress('::ffff:7f00:1')).toBe(true); // mapped 127.0.0.1
    expect(isBlockedIpAddress('64:ff9b::a9fe:a9fe')).toBe(true); // NAT64 -> 169.254.169.254
  });
  it('explicitly blocks the :: unspecified and ::1 loopback singletons', () => {
    expect(isBlockedIpAddress('::')).toBe(true);
    expect(isBlockedIpAddress('::1')).toBe(true);
    expect(isBlockedIpAddress('0:0:0:0:0:0:0:1')).toBe(true); // fully-expanded ::1
    expect(isBlockedIpAddress('0:0:0:0:0:0:0:0')).toBe(true); // fully-expanded ::
  });
  it('allows a public IPv6', () => {
    expect(isBlockedIpAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isBlockedHostLiteral', () => {
  it('blocks localhost family and bracketed IPv6 loopback', () => {
    expect(isBlockedHostLiteral('localhost')).toBe(true);
    expect(isBlockedHostLiteral('app.localhost')).toBe(true);
    expect(isBlockedHostLiteral('printer.local')).toBe(true);
    expect(isBlockedHostLiteral('[::1]')).toBe(true);
    expect(isBlockedHostLiteral('127.0.0.1')).toBe(true);
    expect(isBlockedHostLiteral('192.168.1.10')).toBe(true);
  });
  it('allows public hostnames (including fd-prefixed) and public IPs', () => {
    expect(isBlockedHostLiteral('fdic.gov')).toBe(false);
    expect(isBlockedHostLiteral('images.example.edu')).toBe(false);
    expect(isBlockedHostLiteral('8.8.8.8')).toBe(false);
  });
  it('blocks inet_aton-style numeric encodings of a private IPv4 (decimal/hex/octal/short/mixed)', () => {
    // All of these address 127.0.0.1 (or 10.0.0.1) that a dotted-quad-only check would miss.
    expect(isBlockedHostLiteral('2130706433')).toBe(true); // decimal 32-bit
    expect(isBlockedHostLiteral('0x7f000001')).toBe(true); // hex 32-bit
    expect(isBlockedHostLiteral('017700000001')).toBe(true); // octal 32-bit
    expect(isBlockedHostLiteral('127.1')).toBe(true); // short dotted
    expect(isBlockedHostLiteral('10.0.1')).toBe(true); // short dotted -> 10.0.0.1
    expect(isBlockedHostLiteral('0x7f.0.0.1')).toBe(true); // mixed hex + decimal
  });
  // YUK-229 review — leading-zero octet bypass. inet_aton / glibc / WHATWG all read a
  // leading-zero octet as OCTAL, so these dotted-quads address loopback / RFC1918 destinations.
  // Reading them as decimal (12.0.0.1, 177.0.0.1) would classify them public and let them through.
  it('blocks leading-zero (octal) dotted-quad octets using inet semantics, not decimal', () => {
    expect(isBlockedHostLiteral('0177.0.0.1')).toBe(true); // octal 0177 = 127 -> 127.0.0.1
    expect(isBlockedHostLiteral('012.0.0.1')).toBe(true); // octal 012 = 10 -> 10.0.0.1
    expect(isBlockedHostLiteral('0x7f.1')).toBe(true); // hex 0x7f + short dotted -> 127.0.0.1
    expect(isBlockedHostLiteral('010.0.0.1')).toBe(true); // octal 010 = 8; blocked fail-closed
    expect(isBlockedHostLiteral('192.168.001.001')).toBe(true); // octal 001 = 1 -> 192.168.1.1
    expect(isBlockedHostLiteral('0300.0250.0.1')).toBe(true); // octal -> 192.168.0.1
    // A leading-zero token with a non-octal digit is malformed under inet semantics (WHATWG URL
    // rejects the host outright) — fail closed rather than silently reading it as decimal.
    expect(isBlockedHostLiteral('069.254.0.1')).toBe(true);
    // Canonical public IPv4 and hostnames are untouched by the stricter dotted-quad parse.
    expect(isBlockedHostLiteral('127.0.0.1')).toBe(true);
    expect(isBlockedHostLiteral('8.8.8.8')).toBe(false);
    expect(isBlockedHostLiteral('93.184.216.34')).toBe(false);
    expect(isBlockedHostLiteral('images.example.edu')).toBe(false);
  });
  it('fails closed when a leading-zero literal is passed straight to isBlockedIpAddress', () => {
    // isBlockedIpAddress's contract is "callers pass an actual IP literal"; a leading-zero form
    // is not one, so it must be treated as blocked rather than parsed as decimal.
    expect(isBlockedIpAddress('012.0.0.1')).toBe(true);
    expect(isBlockedIpAddress('0177.0.0.1')).toBe(true);
  });
  it('fails closed on numeric-looking hosts that do not parse, without touching real domains', () => {
    expect(isBlockedHostLiteral('0x')).toBe(true); // empty hex
    expect(isBlockedHostLiteral('08')).toBe(true); // bad octal digit
    expect(isBlockedHostLiteral('999999999999')).toBe(true); // overflows 32 bits
    expect(isBlockedHostLiteral('1.2.3.4.5')).toBe(true); // too many numeric octets
    // Real domains whose labels happen to be all-hex letters must stay on the hostname path
    // (no 0x prefix, not pure digits) — they are NOT numeric forms.
    expect(isBlockedHostLiteral('abc.de')).toBe(false);
    expect(isBlockedHostLiteral('dead.beef')).toBe(false);
    expect(isBlockedHostLiteral('example.com')).toBe(false);
  });
  it('strips the IPv6 zone id and fails closed on unparseable bracketed literals', () => {
    // Zone id (%25eth0 = %eth0) must be stripped before parsing, then the link-local address is
    // still recognized and blocked.
    expect(isBlockedHostLiteral('[fe80::1%25eth0]')).toBe(true);
    expect(isBlockedHostLiteral('[fe80::1%eth0]')).toBe(true);
    expect(isBlockedHostLiteral('fe80::1%eth0')).toBe(true);
    // Fail-closed: a bracketed literal that does not parse as IPv6 is refused, not passed through
    // to the (potentially allowed) hostname branch.
    expect(isBlockedHostLiteral('[garbage]')).toBe(true);
    expect(isBlockedHostLiteral('[fe80::zz%eth0]')).toBe(true);
    // A bracketed public IPv6 with a zone id stays allowed once the zone is stripped.
    expect(isBlockedHostLiteral('[2606:4700:4700::1111%eth0]')).toBe(false);
  });

  it('normalizes a trailing FQDN dot so localhost. / *.local. / *.localhost. cannot bypass', () => {
    expect(isBlockedHostLiteral('localhost.')).toBe(true);
    expect(isBlockedHostLiteral('printer.local.')).toBe(true);
    expect(isBlockedHostLiteral('foo.localhost.')).toBe(true);
    expect(isBlockedHostLiteral('127.0.0.1.')).toBe(true);
    expect(isBlockedHostLiteral('192.168.1.10.')).toBe(true);
    // A public host with a trailing dot stays allowed.
    expect(isBlockedHostLiteral('images.example.edu.')).toBe(false);
  });
});

describe('isPublicHttpUrl', () => {
  it('accepts public http(s) image URLs', () => {
    expect(isPublicHttpUrl('https://images.example.edu/wenyan/scan.png')).toBe(true);
    expect(isPublicHttpUrl('http://example.com/a.png')).toBe(true);
  });
  it('rejects non-http(s) protocols and credentials', () => {
    expect(isPublicHttpUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isPublicHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isPublicHttpUrl('ftp://example.com/a.png')).toBe(false);
    expect(isPublicHttpUrl('https://user:pass@example.com/a.png')).toBe(false);
    expect(isPublicHttpUrl('not a url')).toBe(false);
  });
  it('rejects literal private / loopback / link-local / NAT64 hosts', () => {
    for (const url of [
      'http://localhost/x.png',
      'http://127.0.0.1/x.png',
      'http://10.0.0.5/x.png',
      'http://192.168.1.10/x.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x.png',
      'http://[fd00::1]/x.png',
      'http://[::ffff:7f00:1]/x.png',
      'http://[64:ff9b::a9fe:a9fe]/x.png',
      'http://localhost./x.png', // trailing FQDN dot must not bypass
      'http://printer.local./x.png',
      'http://2130706433/x.png', // decimal-encoded 127.0.0.1
      'http://0x7f000001/x.png', // hex-encoded 127.0.0.1
      'http://127.1/x.png', // short-dotted 127.0.0.1
      'http://0177.0.0.1/x.png', // octal leading-zero octet -> 127.0.0.1
      'http://012.0.0.1/x.png', // octal leading-zero octet -> 10.0.0.1
      'http://0x7f.1/x.png', // hex octet + short dotted -> 127.0.0.1
    ]) {
      expect(isPublicHttpUrl(url)).toBe(false);
    }
  });
  it('pins that WHATWG URL parsing normalizes leading-zero octets to octal before the guard', () => {
    // Documents why the leading-zero fail-closed rule lives in isBlockedHostLiteral (the
    // direct/non-URL entry point) rather than here: `new URL` has already resolved the ambiguity
    // to octal by the time isPublicHttpUrl inspects the hostname, so the guard only ever sees a
    // canonical dotted-quad and returns the same verdict the browser/fetch would act on.
    expect(new URL('http://012.0.0.1/x.png').hostname).toBe('10.0.0.1');
    expect(new URL('http://0177.0.0.1/x.png').hostname).toBe('127.0.0.1');
    // 010 is octal 8 — a genuinely public address once normalized, so it is correctly allowed
    // through the URL path even though the raw literal is refused fail-closed.
    expect(new URL('http://010.0.0.1/x.png').hostname).toBe('8.0.0.1');
    expect(isPublicHttpUrl('http://010.0.0.1/x.png')).toBe(true);
  });
});

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
    ]) {
      expect(isPublicHttpUrl(url)).toBe(false);
    }
  });
});

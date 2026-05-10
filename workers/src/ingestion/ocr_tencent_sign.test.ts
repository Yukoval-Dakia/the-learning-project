import { describe, it, expect } from 'vitest';
import { sha256Hex, hmacSha256Hex, buildCanonicalRequest, buildStringToSign, deriveSigningKey, buildAuthHeader } from './ocr_tencent_sign';

describe('sha256Hex', () => {
  it('hashes empty string to known SHA-256', async () => {
    const out = await sha256Hex('');
    expect(out).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes simple string', async () => {
    const out = await sha256Hex('abc');
    expect(out).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('buildCanonicalRequest', () => {
  it('builds canonical request with signed_headers content-type;host', async () => {
    const out = await buildCanonicalRequest({
      method: 'POST',
      uri: '/',
      query: '',
      contentType: 'application/json; charset=utf-8',
      host: 'ocr.tencentcloudapi.com',
      payloadJson: '{"ImageBase64":"abc"}',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('POST');
    expect(lines[1]).toBe('/');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('content-type:application/json; charset=utf-8');
    expect(lines[4]).toBe('host:ocr.tencentcloudapi.com');
    expect(lines[5]).toBe('');
    expect(lines[6]).toBe('content-type;host');
    expect(lines[7]).toBe(await sha256Hex('{"ImageBase64":"abc"}'));
  });
});

describe('buildStringToSign', () => {
  it('formats algo / timestamp / scope / hashed-canonical', async () => {
    const out = await buildStringToSign({
      timestamp: 1700000000,
      service: 'ocr',
      canonicalRequest: 'CR_PLACEHOLDER',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('TC3-HMAC-SHA256');
    expect(lines[1]).toBe('1700000000');
    // 1700000000 is 2023-11-14 UTC → date "2023-11-14"
    expect(lines[2]).toBe('2023-11-14/ocr/tc3_request');
    expect(lines[3]).toBe(await sha256Hex('CR_PLACEHOLDER'));
  });
});

describe('deriveSigningKey', () => {
  it('chains TC3{secretKey} → date → service → tc3_request', async () => {
    const key = await deriveSigningKey({
      secretKey: 'TEST_SECRET',
      date: '2024-01-01',
      service: 'ocr',
    });
    expect(key.byteLength).toBe(32); // HMAC-SHA256 output
    const key2 = await deriveSigningKey({
      secretKey: 'TEST_SECRET',
      date: '2024-01-01',
      service: 'ocr',
    });
    // Determinism check
    expect(new Uint8Array(key)).toEqual(new Uint8Array(key2));
  });
});

describe('buildAuthHeader', () => {
  it('produces TC3 Authorization header w/ deterministic signature for fixed inputs', async () => {
    const auth = await buildAuthHeader({
      secretId: 'AKID0000',
      secretKey: 'TEST_SECRET',
      timestamp: 1700000000,
      service: 'ocr',
      action: 'EduPaperOCR',
      payloadJson: '{"ImageBase64":"abc"}',
      host: 'ocr.tencentcloudapi.com',
    });
    expect(auth.startsWith('TC3-HMAC-SHA256 Credential=AKID0000/2023-11-14/ocr/tc3_request, ')).toBe(true);
    expect(auth).toContain('SignedHeaders=content-type;host,');
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
    // Determinism: same inputs → same output
    const auth2 = await buildAuthHeader({
      secretId: 'AKID0000',
      secretKey: 'TEST_SECRET',
      timestamp: 1700000000,
      service: 'ocr',
      action: 'EduPaperOCR',
      payloadJson: '{"ImageBase64":"abc"}',
      host: 'ocr.tencentcloudapi.com',
    });
    expect(auth).toBe(auth2);
  });
});

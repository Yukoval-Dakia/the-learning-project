// TC3-HMAC-SHA256 signing for Tencent Cloud APIs.
// Implemented with Web Crypto so it runs inside Cloudflare Workers.
//
// Reference: https://cloud.tencent.com/document/api/213/30654
// Signed headers = "content-type;host" (matches official Python SDK).

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(hash);
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const keyBuf = key instanceof Uint8Array ? key : new Uint8Array(key);
  const ck = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(data));
}

export async function hmacSha256Hex(key: ArrayBuffer | Uint8Array, data: string): Promise<string> {
  return bytesToHex(await hmacSha256(key, data));
}

export interface CanonicalRequestArgs {
  method: 'POST' | 'GET';
  uri: string;
  query: string;
  contentType: string;
  host: string;
  payloadJson: string;
}

export async function buildCanonicalRequest(a: CanonicalRequestArgs): Promise<string> {
  const hashedPayload = await sha256Hex(a.payloadJson);
  return [
    a.method,
    a.uri,
    a.query,
    `content-type:${a.contentType}`,
    `host:${a.host}`,
    '',
    'content-type;host',
    hashedPayload,
  ].join('\n');
}

export interface StringToSignArgs {
  timestamp: number; // unix seconds
  service: string;
  canonicalRequest: string;
}

export async function buildStringToSign(a: StringToSignArgs): Promise<string> {
  const date = new Date(a.timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
  const scope = `${date}/${a.service}/tc3_request`;
  const hashedCR = await sha256Hex(a.canonicalRequest);
  return ['TC3-HMAC-SHA256', String(a.timestamp), scope, hashedCR].join('\n');
}

export interface DeriveSigningKeyArgs {
  secretKey: string;
  date: string; // YYYY-MM-DD
  service: string;
}

export async function deriveSigningKey(a: DeriveSigningKeyArgs): Promise<ArrayBuffer> {
  const k0 = new TextEncoder().encode(`TC3${a.secretKey}`);
  const kDate = await hmacSha256(k0, a.date);
  const kService = await hmacSha256(kDate, a.service);
  const kSigning = await hmacSha256(kService, 'tc3_request');
  return kSigning;
}

export interface BuildAuthArgs {
  secretId: string;
  secretKey: string;
  timestamp: number;
  service: string;
  action: string;
  payloadJson: string;
  host: string;
}

export async function buildAuthHeader(a: BuildAuthArgs): Promise<string> {
  const date = new Date(a.timestamp * 1000).toISOString().slice(0, 10);
  const cr = await buildCanonicalRequest({
    method: 'POST',
    uri: '/',
    query: '',
    contentType: 'application/json; charset=utf-8',
    host: a.host,
    payloadJson: a.payloadJson,
  });
  const sts = await buildStringToSign({
    timestamp: a.timestamp,
    service: a.service,
    canonicalRequest: cr,
  });
  const signingKey = await deriveSigningKey({
    secretKey: a.secretKey,
    date,
    service: a.service,
  });
  const signatureHex = await hmacSha256Hex(signingKey, sts);
  return (
    `TC3-HMAC-SHA256 ` +
    `Credential=${a.secretId}/${date}/${a.service}/tc3_request, ` +
    `SignedHeaders=content-type;host, ` +
    `Signature=${signatureHex}`
  );
}

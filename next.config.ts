import type { NextConfig } from 'next';

// Baseline security headers applied to every route. Deliberately NO
// Content-Security-Policy: a wrong CSP breaks the React / katex / cytoscape /
// tiptap runtime (inline styles, wasm, web workers). A vetted CSP is tracked as
// a follow-up (YUK-135). Strict-Transport-Security is safe because ingress is
// HTTPS-only via the Cloudflare Tunnel.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Don't advertise the framework in the `X-Powered-By` response header.
  poweredByHeader: false,
  // pg-boss + pg + pgpass use Node built-ins (fs, path, stream) that webpack
  // can't resolve when they get bundled into instrumentation.ts (the
  // instrumentation hook compiles as a separate, more minimal bundle than
  // server route code, with fewer polyfills). Marking these as external means
  // Next emits a plain `require()` at runtime and Node resolves them normally.
  //
  // @hyzyla/pdfium (YUK-250 PDF render) MUST also be external: its ESM entry
  // loads its WASM via `new URL("pdfium.wasm", import.meta.url)`. If webpack
  // bundles the JS into the route chunk, that import.meta.url no longer points
  // at the package dir AND @vercel/nft never traces the sibling pdfium.wasm —
  // so the standalone build that ships to the NAS container omits both the
  // package and the .wasm, and the first PDF upload 500s with
  // "Cannot find module"/wasm-not-found. Externalizing keeps the package on
  // disk so the tracer copies dist/index.esm.js + dist/pdfium.wasm into
  // .next/standalone (verified: `find .next/standalone -iname pdfium.wasm`).
  serverExternalPackages: ['pg', 'pg-boss', 'pgpass', 'pg-connection-string', '@hyzyla/pdfium'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;

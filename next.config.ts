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
  serverExternalPackages: ['pg', 'pg-boss', 'pgpass', 'pg-connection-string'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;

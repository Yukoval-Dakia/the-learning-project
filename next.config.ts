import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // pg-boss + pg + pgpass use Node built-ins (fs, path, stream) that webpack
  // can't resolve when they get bundled into instrumentation.ts (the
  // instrumentation hook compiles as a separate, more minimal bundle than
  // server route code, with fewer polyfills). Marking these as external means
  // Next emits a plain `require()` at runtime and Node resolves them normally.
  serverExternalPackages: ['pg', 'pg-boss', 'pgpass', 'pg-connection-string'],
};

export default nextConfig;

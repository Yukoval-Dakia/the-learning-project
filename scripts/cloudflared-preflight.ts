import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

export type TunnelPreflightResult =
  | { ok: true; protocol: 'auto' | 'http2' | 'quic' }
  | { ok: false; message: string };

export function validateTunnelEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): TunnelPreflightResult {
  if (!env.TUNNEL_TOKEN?.trim()) {
    return {
      ok: false,
      message:
        'TUNNEL_TOKEN is empty. Generate a connector token in Cloudflare Zero Trust and add it to .env.',
    };
  }

  const protocol = env.TUNNEL_PROTOCOL?.trim() || 'auto';
  if (protocol !== 'auto' && protocol !== 'http2' && protocol !== 'quic') {
    return {
      ok: false,
      message: `TUNNEL_PROTOCOL must be auto, http2, or quic; received ${JSON.stringify(protocol)}.`,
    };
  }

  return { ok: true, protocol };
}

export function runTunnelPreflight(): number {
  config({ path: '.env', override: false, quiet: true });
  const result = validateTunnelEnvironment();
  if (!result.ok) {
    console.error(`[cloudflared:preflight] ${result.message}`);
    return 1;
  }

  console.log(`[cloudflared:preflight] token present; protocol=${result.protocol}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runTunnelPreflight());
}

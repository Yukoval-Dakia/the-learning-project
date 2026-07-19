import { describe, expect, it } from 'vitest';
import { validateTunnelEnvironment } from './cloudflared-preflight';

describe('validateTunnelEnvironment', () => {
  it('rejects a missing or blank connector token', () => {
    expect(validateTunnelEnvironment({})).toEqual({
      ok: false,
      message:
        'TUNNEL_TOKEN is empty. Generate a connector token in Cloudflare Zero Trust and add it to .env.',
    });
    expect(validateTunnelEnvironment({ TUNNEL_TOKEN: '   ' })).toEqual(
      validateTunnelEnvironment({}),
    );
  });

  it('defaults to automatic protocol selection', () => {
    expect(validateTunnelEnvironment({ TUNNEL_TOKEN: 'TOKEN' })).toEqual({
      ok: true,
      protocol: 'auto',
    });
  });

  it.each(['auto', 'http2', 'quic'] as const)('accepts protocol %s', (protocol) => {
    expect(validateTunnelEnvironment({ TUNNEL_TOKEN: 'TOKEN', TUNNEL_PROTOCOL: protocol })).toEqual(
      {
        ok: true,
        protocol,
      },
    );
  });

  it('rejects an unsupported protocol before compose starts', () => {
    expect(validateTunnelEnvironment({ TUNNEL_TOKEN: 'TOKEN', TUNNEL_PROTOCOL: 'udp' })).toEqual({
      ok: false,
      message: 'TUNNEL_PROTOCOL must be auto, http2, or quic; received "udp".',
    });
  });
});

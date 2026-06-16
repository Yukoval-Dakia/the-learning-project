// YUK-365 (Codex review P2, Finding 2): loadEnv is the shared env loader the Hono
// API (server/index.ts) AND the standalone pg-boss worker (scripts/worker.ts) now
// both call at startup, so the AI provider toggle (AI_PROVIDER_OVERRIDE /
// CLAUDE_CODE_OAUTH_TOKEN placed in .env.local) reaches ALL three processes. This
// pins the two contracts the worker fix depends on:
//   1. .env.local is read AND its keys win over .env (precedence).
//   2. loadEnv only fills UNSET keys — a real environment / docker-compose-injected
//      value always wins (so prod container env is never clobbered).
//
// Pure no-DB unit (server/**/*.unit.test.ts → fastTestInclude). Writes throwaway
// .env / .env.local files into an os.tmpdir() sandbox and points loadEnv at it via
// its rootDir arg; never touches the repo's real .env.local (which holds a real
// CLAUDE_CODE_OAUTH_TOKEN). Test values are all dummy.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const KEYS = [
  'YUK365_FROM_LOCAL_ONLY',
  'YUK365_FROM_ENV_ONLY',
  'YUK365_IN_BOTH',
  'YUK365_PREEXISTING',
] as const;

let sandbox: string;

function snapshot(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of KEYS) out[k] = process.env[k];
  return out;
}

describe('loadEnv — .env.local precedence + only-fill-unset (Finding 2)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = snapshot();
    for (const k of KEYS) delete process.env[k];
    sandbox = mkdtempSync(join(tmpdir(), 'yuk365-env-'));
    writeFileSync(
      join(sandbox, '.env'),
      [
        'YUK365_FROM_ENV_ONLY=from-env',
        'YUK365_IN_BOTH=env-value',
        'YUK365_PREEXISTING=env-file-value',
      ].join('\n'),
    );
    writeFileSync(
      join(sandbox, '.env.local'),
      ['YUK365_FROM_LOCAL_ONLY=from-local', 'YUK365_IN_BOTH=local-value'].join('\n'),
    );
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('reads keys that live only in .env.local (the toggle file the worker now loads)', () => {
    loadEnv(sandbox);
    expect(process.env.YUK365_FROM_LOCAL_ONLY).toBe('from-local');
  });

  it('reads keys that live only in .env', () => {
    loadEnv(sandbox);
    expect(process.env.YUK365_FROM_ENV_ONLY).toBe('from-env');
  });

  it('.env.local wins over .env when a key is in both', () => {
    loadEnv(sandbox);
    expect(process.env.YUK365_IN_BOTH).toBe('local-value');
  });

  it('does NOT clobber a pre-existing process.env value (real/container env always wins)', () => {
    process.env.YUK365_PREEXISTING = 'real-runtime-value';
    loadEnv(sandbox);
    expect(process.env.YUK365_PREEXISTING).toBe('real-runtime-value');
  });
});

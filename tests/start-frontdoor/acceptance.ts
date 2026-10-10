import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { buildHonoApp } from '../../server/app';
import { createFrontdoor } from '../../server/frontdoor';

const secretNames = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_API_KEY',
  'ZAI_CODING_CN_API_KEY',
  'OPENCODE_API_KEY',
  'OPENROUTER_API_KEY',
  'ZHIPU_API_KEY',
  'DASHSCOPE_API_KEY',
  'EXA_API_KEY',
  'LMNR_PROJECT_API_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'INTERNAL_TOKEN',
  'JUDGE_PROVENANCE_SECRET',
  'TENCENT_SECRET_ID',
  'TENCENT_SECRET_KEY',
];
// One process owns injection, build and scanning, so a scan cannot pass on arbitrary sentinels.
assert.ok(
  process.argv.includes('--build'),
  'Run acceptance:start-frontdoor --build to inject canaries',
);
for (const name of secretNames) process.env[name] = `yuk1401-canary-${name}-${randomUUID()}`;
const built = spawnSync('pnpm', ['build'], { env: process.env, stdio: 'inherit' });
assert.equal(built.error, undefined, 'Build must start');
assert.equal(built.status, 0, 'Canary-injected build must succeed');
const canaries = secretNames.map((name) => {
  const value = process.env[name];
  assert.ok(value);
  return value;
});
async function scanClient(directory: string): Promise<number> {
  let javascriptFiles = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      javascriptFiles += await scanClient(path);
      continue;
    }
    const bytes = await readFile(path);
    for (const canary of canaries)
      assert.equal(bytes.includes(canary), false, `Secret canary in ${path}`);
    if (/\.(?:js|mjs)$/.test(entry.name)) javascriptFiles++;
  }
  return javascriptFiles;
}
const spaFiles = await scanClient('web/dist');
const startFiles = await scanClient('dist/start/client');
assert.ok(spaFiles > 0, 'SPA browser JavaScript must be scanned');
assert.ok(startFiles > 0, 'Start browser JavaScript must be scanned');

// Isolated real frontdoor listener; no worker, business DB or provider calls.
const api = buildHonoApp([], { epochGate: async () => ({ runnable: true }) });
const fetchFrontdoor = await createFrontdoor(api, 'web/dist');
const listener = serve({ fetch: fetchFrontdoor, hostname: '127.0.0.1', port: 0 });
await new Promise<void>((resolve, reject) => {
  listener.once('listening', resolve);
  listener.once('error', reject);
});
const address = listener.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
try {
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/ready`)).status, 200);
  assert.equal((await fetch(`${base}/api/auth/check`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/auth/check`, { headers: { 'x-internal-token': 'wrong' } })).status,
    401,
  );
  const token = process.env.INTERNAL_TOKEN;
  assert.ok(token);
  assert.equal(
    (await fetch(`${base}/api/auth/check`, { headers: { 'x-internal-token': token } })).status,
    200,
  );
  // Start server functions live outside /api/*; the frontdoor must still
  // reject tokenless calls and fence them while the epoch is not runnable.
  for (const method of ['GET', 'POST']) {
    assert.equal((await fetch(`${base}/_serverFn/not-shipped`, { method })).status, 401);
  }
  const fenced = buildHonoApp([], {
    epochGate: async () => ({ runnable: false, reason: 'unavailable' }),
  });
  const fencedFrontdoor = await createFrontdoor(fenced, 'web/dist');
  assert.equal(
    (
      await fencedFrontdoor(
        new Request(`${base}/_serverFn/not-shipped`, { headers: { 'x-internal-token': token } }),
      )
    ).status,
    503,
  );
  console.log(
    JSON.stringify({
      status: 'PASS',
      spaFiles,
      startFiles,
      injectedCanaries: canaries.length,
      tokenAndExemptions: 'PASS',
      serverFunctionAuth: 401,
      serverFunctionFenced: 503,
    }),
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
}

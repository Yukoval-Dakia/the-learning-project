import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('requires an explicit database target before an imported CLI can load a local .env', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'tlp-migrate-target-'));
  try {
    const outfile = join(fixtureDir, 'migrate.cjs');
    await build({
      entryPoints: [resolve('scripts/migrate.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      external: ['pg-native', 'bufferutil', 'utf-8-validate'],
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    // Invalid on purpose: even a regressed build cannot connect to a real database.
    await writeFile(join(fixtureDir, '.env'), 'DATABASE_URL=not-a-database-url\n');
    const env = { ...process.env };
    delete env.DATABASE_URL;
    await expect(
      promisify(execFile)(process.execPath, [outfile], { cwd: fixtureDir, env }),
    ).rejects.toMatchObject({ code: 1, stderr: '[migrate] DATABASE_URL not set\n' });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

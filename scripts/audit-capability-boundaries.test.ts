import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { auditCapabilityBoundaries } from './audit-capability-boundaries';

// @invariant security: CI admission rejects capability -> server growth even when the ledger is raised to match.
// @fails-if a ledger edit alone lets a new capability -> server edge pass the CLI.
test('rejects dependency growth even when the ledger is raised', () => {
  const root = mkdtempSync(join(tmpdir(), 'capability-ratchet-'));
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', ...args],
      { cwd: root, encoding: 'utf8' },
    );
  try {
    const baseline = auditCapabilityBoundaries(root).dependencySnapshot;
    write('scripts/capability-boundary-baseline.json', JSON.stringify(baseline));
    git('init', '-q');
    git('add', '.');
    git('commit', '--no-gpg-sign', '-qm', 'baseline');
    write('src/server/ai.ts', 'export {};');
    write('src/capabilities/practice/public.ts', "import '@/server/ai';");
    baseline.debts.capabilityToServer.byOwnerPair['practice -> ai'] = 1;
    baseline.debts.capabilityToServer.total = 1;
    write('scripts/capability-boundary-baseline.json', JSON.stringify(baseline));
    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('scripts/audit-capability-boundaries.ts'),
        '--base',
        git('rev-parse', 'HEAD').trim(),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('1 > base commit 0');
  } finally {
    rmSync(root, { recursive: true });
  }
});

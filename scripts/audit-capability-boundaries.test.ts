import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { auditCapabilityBoundaries } from './audit-capability-boundaries';

// @invariant security: YUK-1570 owner-approved CI admission rejects growth without a real offset or recorded ruling.
// @fails-if reason/exitCondition or an unsupported offset claim lets a net increase pass the CLI.
test('rejects an increase without a real offset or recorded ruling', () => {
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
    write(
      'scripts/capability-boundary-baseline.json',
      JSON.stringify({
        ...baseline,
        changes: [
          {
            direction: 'increase',
            debt: 'capabilityToServer',
            pair: 'practice -> ai',
            date: '2026-10-19',
            from: 0,
            to: 1,
            reason: 'Add an owner-service import',
            exitCondition: 'Remove the import when the consumer retires',
            justification: { kind: 'offset' },
          },
        ],
      }),
    );
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
    expect(result.stderr).toContain('offset requires');
  } finally {
    rmSync(root, { recursive: true });
  }
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { containerBoundaryInclude } from '../../vitest.shared';

if (!process.env.WORKSPACE_IMAGE)
  throw new Error('WORKSPACE_IMAGE must name the owned dev worker image');
const directory = mkdtempSync(join(tmpdir(), 'workspace-boundary-'));
try {
  for (const file of containerBoundaryInclude) {
    const bundle = join(directory, 'boundary.cjs');
    execFileSync(
      'pnpm',
      [
        'exec',
        'esbuild',
        file,
        '--bundle',
        '--platform=node',
        '--target=node24',
        '--format=cjs',
        `--outfile=${bundle}`,
        ...[
          'winston',
          'winston-transport',
          'pg-native',
          'sharp',
          'better-sqlite3',
          'bufferutil',
          'utf-8-validate',
          'mermaid',
          'jsdom',
          '@lmnr-ai/lmnr',
        ].map((name) => `--external:${name}`),
      ],
      { stdio: 'inherit' },
    );
    execFileSync('sh', [resolve('scripts/workspace/run-boundary.sh')], {
      stdio: 'inherit',
      env: { ...process.env, WORKSPACE_BOUNDARY_BUNDLE: bundle },
    });
  }
} finally {
  rmSync(directory, { recursive: true });
}

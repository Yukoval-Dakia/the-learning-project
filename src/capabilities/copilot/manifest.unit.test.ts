import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { copilotCapability } from './manifest';

describe('copilot durable job declarations (YUK-596)', () => {
  it('gives paid execution a heartbeat and mounts a singleton fast reconciliation floor', () => {
    const handlers = copilotCapability.jobs?.handlers ?? [];
    expect(handlers.find((handler) => handler.name === 'copilot_run')).toEqual({
      name: 'copilot_run',
      queue: 'agent',
      heartbeatSeconds: 30,
      load: expect.any(Function),
    });
    expect(handlers.find((handler) => handler.name === 'copilot_run_reconcile')).toMatchObject({
      queue: 'fast',
      schedule: {
        cron: '0-58/2 * * * *',
        tz: 'Asia/Shanghai',
        singletonKey: 'copilot_run_reconcile-sweep',
        singletonSeconds: 120,
      },
    });
  });

  it('owns the run worker and deletes every central implementation path', () => {
    const root = process.cwd();
    expect(existsSync(join(root, 'src/capabilities/copilot/jobs/copilot_run.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/capabilities/copilot/jobs/copilot_run.test.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/server/boss/handlers/copilot_run.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/server/boss/handlers/copilot_run.test.ts'))).toBe(false);

    const manifest = readFileSync(join(root, 'src/capabilities/copilot/manifest.ts'), 'utf8');
    const reconcile = readFileSync(
      join(root, 'src/capabilities/copilot/jobs/copilot_run_reconcile.ts'),
      'utf8',
    );
    expect(manifest).toContain("import('./jobs/copilot_run')");
    expect(manifest).not.toContain('@/server/boss/handlers/copilot_run');
    expect(reconcile).toContain("from './copilot_run'");
    expect(reconcile).not.toContain('@/server/boss/handlers/copilot_run');
  });
});

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMemoryIngestRecoveryArgs } from './lib/memory-ingest-recovery-cli';

const replay = [
  'replay',
  '--event',
  'one-owner-event',
  '--request',
  '4b55aeb3-4d59-4944-bbb5-06d8c6307265',
  '--expected-fence',
  'memory_reconcile_v1_add_started_sample',
  '--operator',
  'owner',
  '--reason',
  'Exact lookup remains empty after inspection; accept the ambiguous earlier start.',
  '--allow-paid-replay',
];

describe('memory ingest operator CLI', () => {
  it('defaults to help and keeps inventory read-only and bounded', () => {
    expect(parseMemoryIngestRecoveryArgs([])).toEqual({ kind: 'help' });
    expect(parseMemoryIngestRecoveryArgs(['list'])).toEqual({
      kind: 'list',
      afterId: '',
      limit: 50,
    });
    expect(
      parseMemoryIngestRecoveryArgs(['list', '--limit', '25', '--after', 'marker-25']),
    ).toEqual({ kind: 'list', afterId: 'marker-25', limit: 25 });
  });
  it('requires an explicit single-event authorization with stable identity', () => {
    expect(parseMemoryIngestRecoveryArgs(replay)).toMatchObject({
      kind: 'replay',
      request: {
        sourceEventId: 'one-owner-event',
        operator: 'owner',
        allowPaidReplay: true,
        requestId: '4b55aeb3-4d59-4944-bbb5-06d8c6307265',
      },
    });
    expect(() => parseMemoryIngestRecoveryArgs(replay.slice(0, -1))).toThrow(/allow-paid-replay/);
  });
  it.each([
    ['replay', '--all', '--allow-paid-replay'],
    [...replay, '--event', 'second-event'],
    ['list', '--allow-paid-replay'],
    ['list', '--limit', '101'],
    ['list', '--limit', '1.5'],
    ['list', '--limit'],
    ['clear', '--event', 'one-owner-event'],
    replay.map((value) =>
      value === '4b55aeb3-4d59-4944-bbb5-06d8c6307265' ? 'not-a-uuid' : value,
    ),
  ])('rejects unsafe or malformed arguments %j', (...args) => {
    expect(() => parseMemoryIngestRecoveryArgs(args)).toThrow();
  });
  it('starts real help without DB/Vitest and rejects incomplete replay before runtime initialization', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.VITEST;
    const script = fileURLToPath(new URL('./memory-ingest-recovery.ts', import.meta.url));
    const run = (args: string[]) =>
      execFileSync(process.execPath, ['--import', 'tsx', script, ...args], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    expect(run(['--help'])).toContain('No batch mode');
    try {
      run(['replay', '--event', 'one-owner-event']);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ status: 1 });
      expect(String((error as { stderr?: unknown }).stderr)).toContain('replay requires');
      expect(String((error as { stderr?: unknown }).stderr)).not.toContain('DATABASE_URL');
    }
  });
});

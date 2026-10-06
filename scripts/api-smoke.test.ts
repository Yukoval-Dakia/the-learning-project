import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), config: vi.fn(), kill: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('dotenv', () => ({ config: mocks.config }));
// Keep disposable fixtures inside this worktree; never read the developer's .env.
vi.mock('node:os', () => ({ tmpdir: () => process.cwd() }));

const originalArgv = process.argv;
const fakeToken = 'FAKE-smoke-token-"quoted"=value\\unicode-凭据';
let child: EventEmitter;
let environmentPath: string | undefined;

async function runSmoke(args: string[] = []) {
  process.argv = ['node', 'scripts/api-smoke.ts', ...args];
  await import('./api-smoke');
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  const [command, argv, options] = mocks.spawn.mock.calls[0];
  environmentPath = argv[argv.indexOf('--environment') + 1];
  return { command, argv, options };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  child = new EventEmitter();
  mocks.spawn.mockReturnValue(Object.assign(child, { kill: mocks.kill }));
  vi.stubEnv('INTERNAL_TOKEN', fakeToken);
  vi.stubEnv('API_SMOKE_BASE_URL', 'http://127.0.0.1:3001');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('test process exit');
  });
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.spyOn(process, 'once').mockReturnValue(process);
});

afterEach(() => {
  process.argv = originalArgv;
  if (environmentPath && environmentPath !== 'postman/learning-local.postman_environment.json') {
    rmSync(dirname(environmentPath), { recursive: true, force: true });
  }
  environmentPath = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('api smoke credential transport', () => {
  it('keeps the configured token out of subprocess argv', async () => {
    const { command, argv, options } = await runSmoke(['knowledge', '--bail', '--verbose']);
    expect(command).toBe('pnpm');
    expect(argv).toEqual(
      expect.arrayContaining([
        'dlx',
        'newman@6',
        'run',
        '--folder',
        'knowledge',
        '--bail',
        '--verbose',
      ]),
    );
    expect(argv.join('\0')).not.toContain(fakeToken);
    expect(argv.some((arg: string) => arg.startsWith('internalToken='))).toBe(false);
    expect(options.env.INTERNAL_TOKEN).toBeUndefined();
    expect(process.env.INTERNAL_TOKEN).toBe(fakeToken);
    expect(options.stdio).toBe('inherit');
    expect(mocks.config).toHaveBeenCalledWith({ path: '.env', override: false });
    const contents = readFileSync(environmentPath ?? '', 'utf8');
    expect(JSON.parse(contents)).toMatchObject({
      name: 'learning-local',
      values: [
        { key: 'baseUrl', value: 'http://localhost:3001', enabled: true },
        { key: 'internalToken', value: fakeToken, type: 'secret', enabled: true },
      ],
      _postman_variable_scope: 'environment',
    });
    expect(statSync(dirname(environmentPath ?? '')).mode & 0o077).toBe(0);
    expect(readFileSync('postman/learning-local.postman_environment.json', 'utf8')).not.toContain(
      fakeToken,
    );
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain(fakeToken);
  });

  it('preserves default health and the baseUrl override without a token', async () => {
    vi.stubEnv('INTERNAL_TOKEN', undefined);
    vi.stubEnv('API_SMOKE_BASE_URL', 'http://127.0.0.1:8787');
    const { argv } = await runSmoke();
    expect(argv.slice(-4)).toEqual([
      '--env-var',
      'baseUrl=http://127.0.0.1:8787',
      '--folder',
      'health',
    ]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(environmentPath ?? '', 'utf8')).values).toContainEqual({
      key: 'internalToken',
      value: '',
      type: 'secret',
      enabled: true,
    });
  });

  it('preserves whole-collection selection and the default target', async () => {
    vi.stubEnv('API_SMOKE_BASE_URL', undefined);
    const { argv } = await runSmoke(['--no-folder', '--bail']);
    expect(argv).not.toContain('--no-folder');
    expect(argv).not.toContain('--folder');
    expect(argv.slice(-3)).toEqual(['--env-var', 'baseUrl=http://localhost:3001', '--bail']);
  });

  it('cleans up and forwards an unsuccessful Newman exit', async () => {
    await runSmoke();
    const directory = dirname(environmentPath ?? '');
    expect(() => child.emit('exit', 7, null)).toThrow('test process exit');
    expect(process.exit).toHaveBeenCalledWith(7);
    expect(existsSync(directory)).toBe(false);
  });

  it('cleans up when Newman cannot start, without printing credentials', async () => {
    await runSmoke();
    expect(() => child.emit('error', new Error('spawn failed'))).toThrow('test process exit');
    expect(existsSync(dirname(environmentPath ?? ''))).toBe(false);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain(fakeToken);
  });

  it('cleans up before relaying a Newman termination signal', async () => {
    await runSmoke();
    child.emit('exit', null, 'SIGTERM');
    expect(existsSync(dirname(environmentPath ?? ''))).toBe(false);
    expect(process.kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('cleans up and forwards wrapper %s', async (signal) => {
    await runSmoke();
    const listener = vi.mocked(process.once).mock.calls.find(([event]) => event === signal)?.[1];
    expect(listener).toBeDefined();
    listener?.();
    expect(existsSync(dirname(environmentPath ?? ''))).toBe(false);
    expect(mocks.kill).toHaveBeenCalledWith(signal);
    expect(process.kill).toHaveBeenCalledWith(process.pid, signal);
  });

  it('registers cleanup for wrapper exit, including setup failures', async () => {
    await runSmoke();
    const listener = vi.mocked(process.once).mock.calls.find(([event]) => event === 'exit')?.[1];
    expect(listener).toBeDefined();
    listener?.();
    expect(existsSync(dirname(environmentPath ?? ''))).toBe(false);
  });
});

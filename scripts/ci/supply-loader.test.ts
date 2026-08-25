import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { extractLoaderTarball, verifyLoaderTarball } from './supply-loader.mjs';

const execFile = promisify(execFileCallback);

const runs: string[] = [];

async function tempDir(label: string) {
  const dir = await mkdtemp(join(tmpdir(), `supply-loader-${label}-`));
  runs.push(dir);
  return dir;
}

async function buildLoaderTarball(root: string) {
  const staging = join(root, 'pkg', 'package', 'bin');
  await mkdir(staging, { recursive: true });
  await writeFile(
    join(staging, 'opencode'),
    '#!/bin/sh\necho \'{"name":"build","tools":{"fixture_tool":true}}\'\n',
  );
  await chmod(join(staging, 'opencode'), 0o755);
  await writeFile(
    join(root, 'pkg', 'package', 'package.json'),
    '{"name":"opencode-linux-x64","version":"1.18.10"}\n',
  );
  const tarball = join(root, 'opencode-loader-linux-x64.tgz');
  await execFile('tar', ['-czf', tarball, '-C', join(root, 'pkg'), 'package']);
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(tarball))
    .digest('base64')}`;
  return { tarball, integrity };
}

describe('loader tarball verification', () => {
  it('accepts a tarball whose sha512 matches the pinned integrity and extracts the binary', async () => {
    const root = await tempDir('green');
    const { tarball, integrity } = await buildLoaderTarball(root);
    await expect(
      verifyLoaderTarball({ tarballPath: tarball, expectedIntegrity: integrity }),
    ).resolves.toBe(integrity);
    const binary = await extractLoaderTarball({
      tarballPath: tarball,
      extractRoot: join(root, 'loader'),
    });
    expect(binary).toBe(join(root, 'loader', 'package', 'bin', 'opencode'));
    const run = await execFile(binary);
    expect(JSON.parse(run.stdout)).toEqual({ name: 'build', tools: { fixture_tool: true } });
  });

  it('rejects a tampered tarball on integrity mismatch', async () => {
    const root = await tempDir('tamper');
    const { tarball } = await buildLoaderTarball(root);
    await expect(
      verifyLoaderTarball({ tarballPath: tarball, expectedIntegrity: 'sha512-differentintegrity' }),
    ).rejects.toThrow(/loader tarball integrity mismatch/);
  });

  it('reports a clear error when the tarball lacks package/bin/opencode', async () => {
    const root = await tempDir('layout');
    const empty = join(root, 'empty', 'package');
    await mkdir(empty, { recursive: true });
    await writeFile(join(empty, 'placeholder.txt'), 'not a loader\n');
    const tarball = join(root, 'bad-loader.tgz');
    await execFile('tar', ['-czf', tarball, '-C', join(root, 'empty'), 'package']);
    await expect(
      extractLoaderTarball({ tarballPath: tarball, extractRoot: join(root, 'loader') }),
    ).rejects.toThrow(/did not contain the expected package\/bin\/opencode/);
  });
});

afterEach(async () => {
  await Promise.all(runs.map((dir) => rm(dir, { recursive: true, force: true })));
  runs.length = 0;
});

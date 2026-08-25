import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractDeterministicTar } from './supply-tar-reader.mjs';
import { collectTarEntries, writeDeterministicTar } from './supply-tar-writer.mjs';

const runs: string[] = [];

async function tempDir(label: string) {
  const dir = await mkdtemp(join(tmpdir(), `supply-tar-${label}-`));
  runs.push(dir);
  return dir;
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function makeTree(root: string) {
  await mkdir(join(root, 'pkg', 'node_modules', '.bin'), { recursive: true });
  await mkdir(join(root, 'pkg', 'nested', 'deeply'), { recursive: true });
  await writeFile(join(root, 'pkg', 'package.json'), '{"name":"pkg"}\n');
  await writeFile(join(root, 'pkg', 'node_modules', 'run.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(root, 'pkg', 'node_modules', 'run.sh'), 0o755);
  await writeFile(join(root, 'pkg', 'nested', 'deeply', 'data.txt'), 'payload');
  await symlink('../run.sh', join(root, 'pkg', 'node_modules', '.bin', 'run'));
}

function evilTar() {
  const header = Buffer.alloc(512, 0);
  header.write('../escaped.txt', 0, 'utf8');
  header.write('0000644', 100, 'utf8');
  header.write('00000000004', 108, 'utf8');
  header.write('00000000000', 136, 'utf8');
  header.write('        ', 148, 'utf8');
  header.write('0', 156, 'utf8');
  header.write('ustar', 257, 'utf8');
  header.write('00', 263, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  const payload = Buffer.concat([header, Buffer.from('evil', 'utf8')]);
  const padding = Buffer.alloc(512 - (payload.length % 512), 0);
  return Buffer.concat([payload, padding, Buffer.alloc(1024, 0)]);
}

describe('deterministic tar', () => {
  it('round-trips files, directories, exec bits, and symlinks', async () => {
    const source = await tempDir('round-src');
    const out = join(source, 'closure.tar');
    await makeTree(source);
    const entries = await collectTarEntries(join(source, 'pkg'), 'closure/pkg');
    const first = await writeDeterministicTar(out, entries);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);

    const dest = await tempDir('round-dest');
    const extracted = await extractDeterministicTar(out, join(dest, 'x'));
    expect(extracted.map((entry) => entry.path).sort()).toEqual(
      entries.map((entry) => entry.path).sort(),
    );
    expect(await readFile(join(dest, 'x', 'closure', 'pkg', 'package.json'), 'utf8')).toBe(
      '{"name":"pkg"}\n',
    );
    const runPath = join(dest, 'x', 'closure', 'pkg', 'node_modules', 'run.sh');
    expect((await stat(runPath)).mode & 0o111).not.toBe(0);
    expect(await readlink(join(dest, 'x', 'closure', 'pkg', 'node_modules', '.bin', 'run'))).toBe(
      '../run.sh',
    );
  });

  it('is byte-stable across repeated writes of the same tree', async () => {
    const source = await tempDir('stable');
    await makeTree(source);
    const entries = await collectTarEntries(join(source, 'pkg'), 'closure/pkg');
    const first = await writeDeterministicTar(join(source, 'a.tar'), entries);
    const second = await writeDeterministicTar(join(source, 'b.tar'), entries);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toBe(first.bytes);
  });

  it('archives and restores paths longer than the ustar and GNU longname limits', async () => {
    const source = await tempDir('long');
    const deep = join(
      source,
      'pkg',
      [...Array(12)].map((_, i) => `long-path-segment-padding-${i}-filler`).join('/'),
    );
    await mkdir(deep, { recursive: true });
    const longFile = join(deep, 'leaf.js');
    await writeFile(longFile, 'export {};\n');
    const out = join(source, 'long.tar');
    const entries = await collectTarEntries(join(source, 'pkg'), 'closure/pkg');
    expect(entries.some((entry) => entry.path.length > 255)).toBe(true);
    const written = await writeDeterministicTar(out, entries);
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);

    const dest = await tempDir('long-dest');
    await extractDeterministicTar(out, join(dest, 'x'));
    const restored = join(dest, 'x', 'closure', longFile.slice(source.length + 1));
    expect(await readFile(restored, 'utf8')).toBe('export {};\n');
  });

  it('rejects archives that escape the extraction root', async () => {
    const source = await tempDir('evil');
    await writeFile(join(source, 'evil.tar'), evilTar());
    const dest = await tempDir('evil-dest');
    await expect(
      extractDeterministicTar(join(source, 'evil.tar'), join(dest, 'x')),
    ).rejects.toThrow(/escape|traversal|outside/i);
    expect(await exists(join(dest, 'escaped.txt'))).toBe(false);
  });
});

afterEach(async () => {
  await Promise.all(runs.map((dir) => rm(dir, { recursive: true, force: true })));
  runs.length = 0;
});

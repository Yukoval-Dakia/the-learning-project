// Staging mechanics for the streaming restore: write-failure non-hang,
// duplicate-entry last-wins, and the manifest cap. Real tmpdir files; the
// write failure is injected through a mocked createWriteStream.

import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { Zip, ZipDeflate, strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stageArchive } from './restore-stream';

const fsFlags = vi.hoisted(() => ({ failAssetWrites: false }));

// Only the asset path goes through createWriteStream; row spill files use
// appendFile and readback uses createReadStream, both left real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: (path: string) => {
      if (!fsFlags.failAssetWrites) return actual.createWriteStream(path);
      return new Writable({
        write(_chunk, _enc, cb) {
          cb(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
        },
      }) as unknown as ReturnType<typeof actual.createWriteStream>;
    },
  };
});

const MANIFEST = strToU8(
  JSON.stringify({ schema_version: 'test', include_assets: true, row_counts: {}, asset_count: 1 }),
);

async function stageDirNames(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((n) => n.startsWith('loom-restore-'));
}

function zipWithDuplicates(
  entries: Array<{ name: string; body: Uint8Array }>,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, chunk) => {
      if (err) reject(err);
      else chunks.push(chunk);
    });
    for (const { name, body } of entries) {
      const file = new ZipDeflate(name);
      zip.add(file);
      file.push(body, true);
    }
    zip.end();
    // Zip emits synchronously from push/end; drain on a microtask.
    setImmediate(() => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      resolve(out);
    });
  });
}

describe('stageArchive', () => {
  beforeEach(() => {
    fsFlags.failAssetWrites = false;
  });

  // @invariant data: a spill-file write failure rejects the restore instead of hanging or
  //   half-staging, so a full disk reports cleanly and leaves no residue or partial write
  // @fails-if asset writes waited on 'drain' after an error: the errored stream never drains,
  //   so the stage deadlocks and this case times out; leaked dirs fail the residue assertion
  it('rejects instead of hanging when an asset write fails, and removes the stage dir', async () => {
    fsFlags.failAssetWrites = true;
    const zip = zipSync({
      'manifest.json': MANIFEST,
      'data.json': strToU8('{"knowledge":[]}'),
      'assets/blob.bin': new Uint8Array(4096),
    });
    const before = new Set(await stageDirNames());

    await expect(stageArchive(zip, {}, 1_000_000_000)).rejects.toThrow('ENOSPC');

    const leaked = (await stageDirNames()).filter((n) => !before.has(n));
    expect(leaked).toHaveLength(0);
  });

  // @invariant data: a duplicate data.json entry restores the LAST one, matching the
  //   unzipSync object-map semantics the buffered path had
  // @fails-if staged tables merged or kept the first entry: a 1-row first entry plus empty
  //   second would surface rows the last entry erased, and the rowCount assertions fail
  it('restores only the last of duplicate data.json entries', async () => {
    const zip = await zipWithDuplicates([
      { name: 'manifest.json', body: MANIFEST },
      { name: 'data.json', body: strToU8('{"stale_table":[{"id":1}],"knowledge":[{"id":1}]}') },
      { name: 'data.json', body: strToU8('{"knowledge":[{"id":2},{"id":3}]}') },
    ]);

    const staged = await stageArchive(zip, {}, 1_000_000_000);
    try {
      expect(staged.tables.has('stale_table')).toBe(false);
      expect(staged.tables.get('knowledge')?.rowCount).toBe(2);
    } finally {
      const { cleanupStage } = await import('./restore-stream');
      await cleanupStage(staged.dir);
    }
  });

  // @invariant data: an oversized manifest is refused instead of buffered, so a hostile
  //   archive cannot pin memory inside the one entry kept resident
  // @fails-if the manifest cap were dropped: an entry above it would stage and the rejects
  //   assertion fails
  it('rejects a manifest above the resident cap', async () => {
    const zip = zipSync({
      'manifest.json': new Uint8Array(9 * 1024 * 1024),
      'data.json': strToU8('{}'),
    });
    await expect(stageArchive(zip, {}, 1_000_000_000)).rejects.toThrow('manifest.json too large');
  });
});

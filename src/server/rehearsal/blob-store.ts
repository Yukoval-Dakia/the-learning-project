// Filesystem stand-in for the blob client. Keys are relative paths under the artifact directory.
// This store never reads R2 credentials. A key that escapes the root is rejected.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { R2Client } from '@/kernel/object-storage';

function assertSafeKey(key: string): void {
  const normalized = normalize(key);
  if (
    normalized.startsWith('..') ||
    normalized.startsWith('/') ||
    normalized.includes(`${sep}..`)
  ) {
    throw new Error(`isolated blob key escapes store root: ${key}`);
  }
}

export interface IsolatedBlobStore extends R2Client {
  /** Absolute blob root. The proof hashes files under it. */
  readonly root: string;
  /** Sorted inventory. Order is part of the proof. */
  inventory(): Array<{ key: string; sha256: string; bytes: number }>;
}

export function isolatedBlobStore(root: string): IsolatedBlobStore {
  const absRoot = resolve(root);
  const pathFor = (key: string) => {
    assertSafeKey(key);
    return join(absRoot, key);
  };
  const walk = (dir: string, prefix: string): string[] => {
    let out: string[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      const rel = prefix === '' ? entry : `${prefix}/${entry}`;
      if (statSync(p).isDirectory()) out = out.concat(walk(p, rel));
      else out.push(rel);
    }
    return out;
  };
  return {
    root: absRoot,
    async put(key, body) {
      const path = pathFor(key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    },
    async get(key) {
      try {
        return new Uint8Array(readFileSync(pathFor(key)));
      } catch {
        return null;
      }
    },
    async delete(key) {
      try {
        const { rmSync } = await import('node:fs');
        rmSync(pathFor(key));
      } catch {
        // A missing object is success, matching R2 delete.
      }
    },
    inventory() {
      return walk(absRoot, '')
        .sort()
        .map((key) => {
          const bytes = readFileSync(pathFor(key));
          return {
            key,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.byteLength,
          };
        });
    },
  };
}

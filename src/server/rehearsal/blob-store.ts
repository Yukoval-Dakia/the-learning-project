// ====================================================================
// YUK-1057 — 隔离 blob store（无生产凭证、无 R2 egress）
// ====================================================================
//
// R2Client 兼容的文件系统实现：演练产物的 blob 侧全部落在工件目录下
// （<out>/blobs/<storage_key>），键直接作相对路径（防穿越校验）。
// 明确不读 R2_* env / .env 凭证 —— 「隔离 blobs」的实现约束。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { R2Client } from '@/server/r2';

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
  /** 工件目录下的 blob 根（证明用：sha256 清单）。 */
  readonly root: string;
  /** 当前 blob 清单（key → sha256+size；排序稳定）。 */
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
        // 与 R2 delete 的幂等语义一致：缺对象不视为失败。
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

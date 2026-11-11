import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const BUILD_COMMIT_PATH = '/app/BUILD_COMMIT';
const FULL_SHA_LENGTH = 40;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA_LENGTH = 9;
// 40 hex chars plus a trailing newline. Longer contents are not a commit.
const MAX_BYTES = 64;

// 绝对路径：server bundle 是 CJS，import.meta.url 在产物里是空的。
// 对外只给前 9 位；文件缺失、超长或不是 40 位小写 hex 时为 null，探针不因此失败。
function readSourceCommit(): string | null {
  let fd: number;
  try {
    fd = openSync(BUILD_COMMIT_PATH, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size < FULL_SHA_LENGTH || size > MAX_BYTES) return null;
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    const sha = buf.subarray(0, n).toString('utf8').trim();
    return FULL_SHA.test(sha) ? sha.slice(0, SHORT_SHA_LENGTH) : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** 9 位小写 hex，或 null（这块镜像没有烘焙来源 SHA）。 */
export const sourceCommit: string | null = readSourceCommit();

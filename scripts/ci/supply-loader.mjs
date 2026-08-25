// Loader tarball verification for the YUK-914 required consumer.
//
// The seed step downloads `opencode-<platform>-<arch>` via `npm pack` and
// verifies the tarball's sha512 against bun.lock before uploading it. The
// required consumer re-verifies the downloaded tarball against the same
// in-repo bun.lock integrity (the only trusted source), then extracts the
// platform binary (`package/bin/opencode`) for the offline loader run.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export class LoaderIntegrityError extends Error {}

async function sha512Base64File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha512');
    const stream = createReadStream(path);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('base64')));
  });
}

/** Verifies the downloaded loader tarball digest against the pinned integrity. */
export async function verifyLoaderTarball({ tarballPath, expectedIntegrity }) {
  const actual = `sha512-${await sha512Base64File(tarballPath)}`;
  if (actual !== expectedIntegrity) {
    throw new LoaderIntegrityError(
      `loader tarball integrity mismatch for ${tarballPath}: expected ${expectedIntegrity}, downloaded ${actual}`,
    );
  }
  return actual;
}

/**
 * Extracts the loader binary from its npm tarball and returns the executable
 * path. The opencode platform packages ship exactly `package/bin/opencode`.
 */
export async function extractLoaderTarball({ tarballPath, extractRoot }) {
  await mkdir(extractRoot, { recursive: true });
  execFileSync('tar', ['-xzf', tarballPath, '-C', extractRoot], { stdio: 'inherit' });
  const binary = join(extractRoot, 'package', 'bin', 'opencode');
  try {
    const info = await stat(binary);
    if ((info.mode & 0o111) === 0) {
      throw new LoaderIntegrityError(`loader binary is not executable: ${binary}`);
    }
    return binary;
  } catch (error) {
    if (error instanceof LoaderIntegrityError) throw error;
    throw new LoaderIntegrityError(
      `loader tarball ${tarballPath} did not contain the expected package/bin/opencode binary`,
    );
  }
}

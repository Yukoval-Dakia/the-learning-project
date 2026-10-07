// YUK-1341 — run-time git evidence for actual-output seals. Every paid probe
// records the code it executed: the commit SHA plus (when the tree is dirty) an
// integrity digest of the uncommitted patch material. The digest only verifies
// bytes a reviewer already possesses — this helper does NOT archive the patch
// itself, so an exact dirty tree cannot be rebuilt from these records alone.
// Historical seals whose `working_tree` is 'dirty' are therefore integrity-
// checkable only against separately preserved material; their source snapshots
// are NOT reconstructable from committed records. Clean trees record
// `patch_digest: null` instead of a fabricated digest.
//
// Test-harness helper only — no production caller.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GitEvidence {
  code_revision: string;
  working_tree: 'clean' | 'dirty';
  /**
   * `sha256:<hex>` over tracked diff + untracked file contents; null on clean.
   * Integrity fingerprint only — the patch bytes are not archived, so this is
   * not a reconstructable source snapshot.
   */
  patch_digest: string | null;
  /** Sorted paths the uncommitted patch touches (tracked + untracked). */
  patch_paths: string[];
}

export function captureGitEvidence(repoRoot: string = process.cwd()): GitEvidence {
  const codeRevision = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
  const status = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf8' });
  if (status.trim().length === 0) {
    return {
      code_revision: codeRevision,
      working_tree: 'clean',
      patch_digest: null,
      patch_paths: [],
    };
  }
  const trackedDiff = execSync('git diff HEAD', { cwd: repoRoot, encoding: 'utf8' });
  const untrackedList = execSync('git ls-files --others --exclude-standard', {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const patchPaths = new Set<string>();
  for (const line of status.split('\n')) {
    if (line.length >= 4) patchPaths.add(line.slice(3));
  }
  for (const rel of untrackedList) patchPaths.add(rel);
  const hash = createHash('sha256').update(trackedDiff, 'utf8');
  for (const rel of untrackedList) {
    hash.update(`\n--untracked:${rel}--\n`, 'utf8');
    hash.update(readFileSync(join(repoRoot, rel)));
  }
  return {
    code_revision: codeRevision,
    working_tree: 'dirty',
    patch_digest: `sha256:${hash.digest('hex')}`,
    patch_paths: [...patchPaths].sort(),
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Phase 1c.1 Step 5 — single-owner invariant test (ADR-0005 extended to all
// session types via ADR-0008). Asserts that `db.{insert,update}(learning_session)`
// only appears inside the allowlisted directories. Pure-Node walker — no shell
// exec, no `child_process` (security hook would flag it).

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Hits inside these dirs/files are allowed (the actual single-owner module + the
// Step 3 migration script). Anything else is a violation.
const ALLOWED_PATH_PREFIXES = [
  'src/server/session/',
  'scripts/migrate-phase1c1.ts',
] as const;

// Directories scanned. Only source dirs that produce runtime writes.
const SCAN_ROOTS = ['src', 'app', 'scripts'] as const;

// Skip set — directories that are not part of the runtime app (build output,
// vendored deps, etc.) or which contain only schema/generated content.
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.turbo', '.vercel']);

// Allowed file extensions — TS / TSX only (no need to scan .js or .json for
// db.* call expressions).
const SCAN_EXTS = new Set(['.ts', '.tsx']);

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SCAN_EXTS.has(ext)) out.push(full);
      }
    }
  }
  await recurse(root);
  return out;
}

/**
 * Scan source files for `db.insert(learning_session)` and `db.update(learning_session)`
 * call patterns. Returns the list of file paths (relative to repo root) where matches
 * occur. `db` is matched loosely to allow `tx.insert(learning_session)`, etc.
 *
 * Test files (`*.test.ts` / `*.test.tsx`) are excluded — they seed fixtures
 * directly for hermetic test isolation; that's not an "ownership" concern.
 *
 * Regex tolerates whitespace and any caller binding (db / tx / params.db / etc.).
 */
async function findLearningSessionWriteHits(): Promise<string[]> {
  const re = /\b(?:insert|update)\s*\(\s*learning_session\s*[,)]/;
  const hits: string[] = [];
  for (const root of SCAN_ROOTS) {
    const files = await walkFiles(path.join(REPO_ROOT, root));
    for (const file of files) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
      const text = await fs.readFile(file, 'utf8');
      if (re.test(text)) {
        hits.push(path.relative(REPO_ROOT, file));
      }
    }
  }
  return hits.sort();
}

function isAllowed(relPath: string): boolean {
  // Normalise to forward slashes for cross-platform consistency
  const norm = relPath.split(path.sep).join('/');
  return ALLOWED_PATH_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

describe('session-single-owner invariant', () => {
  it('db.{insert,update}(learning_session) appears ONLY in src/server/session/* and scripts/migrate-phase1c1.ts', async () => {
    const hits = await findLearningSessionWriteHits();
    const violations = hits.filter((h) => !isAllowed(h));
    expect(violations, `Disallowed writers of learning_session found:\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('the single-owner module actually contains learning_session writes (sanity: regex isn\'t over-conservative)', async () => {
    const hits = await findLearningSessionWriteHits();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.startsWith('src/server/session/'))).toBe(true);
  });
});

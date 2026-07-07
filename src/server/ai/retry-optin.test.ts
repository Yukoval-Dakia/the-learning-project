// YUK-576 (review R6) — enableTransientRetry opt-in enforcement.
//
// The single-transient-layer principle (design doc §3.2 / mustFix#6): in-process
// transient retry is ONLY for call paths with no durable backstop — today exactly
// the two vision judges (their catch swallows failures into 'unsupported', so
// pg-boss never sees a throw). A durable job handler that sets
// `enableTransientRetry: true` would stack in-process retry ON TOP of queue
// redelivery (worst case 2×3 paid calls per logical job). This grep-level pin
// fails the build when a new opt-in appears, forcing the author through the
// design-doc gate instead of silently multiplying transient layers.
//
// Pure no-DB unit (node:fs walk only). MUST be enumerated in fastTestInclude
// (vitest.shared.ts): src/server/ai/** has no unit glob.

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

/** The ONLY sanctioned opt-in sites (design doc §1.2.2 / §3.2). */
const SANCTIONED_OPTIN_FILES = [
  'src/server/ai/judges/multimodal-direct-judge.ts',
  'src/server/ai/judges/steps-judge.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // lstat + symlink skip (review P2-#4): statSync would resolve symlinks —
    // traversing a symlinked dir (or throwing on a broken link) would fail this
    // enforcement test for reasons unrelated to opt-in discipline.
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, out);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('enableTransientRetry opt-in enforcement (YUK-576 R6)', () => {
  it('exactly the two vision-judge modules opt in — nowhere else in src/', () => {
    const optInFiles = walk(SRC_ROOT)
      .filter((file) => /enableTransientRetry:\s*true/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file))
      .sort();

    expect(optInFiles).toEqual(SANCTIONED_OPTIN_FILES);
  });
});

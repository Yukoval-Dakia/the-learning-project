// Security & Stability Audit 2026-06-06 — G8-docs invariant tests
// (YUK-242 / YUK-243 / YUK-244).
//
// Pure-Node fs.readFileSync scan (no DB, no Postgres container, no AI) — same
// shape as tests/integration/step12-docs-invariant.test.ts, so this file lives
// in the UNIT partition (enumerated in vitest.shared.ts fastTestInclude).
//
// These guard against the three doc-drift issues re-appearing:
//   - YUK-242: the shared development workflow must point local dev at
//     `pnpm dev:local` (the recommended entry), not bare `pnpm dev`.
//   - YUK-243: AGENTS.md must not hard-code a stale submodule count ("22 子模块").
//   - YUK-244: docs/architecture.md §5.1 Task snapshot must list EVERY task kind
//     registered in src/ai/registry.ts (the canonical source) — no stale snapshot.

import fs from 'node:fs';
import path from 'node:path';
import { taskCatalog } from '@/ai/task-catalog';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

describe('Audit 2026-06-06 G8-docs invariants', () => {
  // ── YUK-242 — shared command source surfaces pnpm dev:local ────────────────

  it('development workflow recommends `pnpm dev:local` as the local entry', () => {
    const content = read('docs/agents/development-workflow.md');
    expect(
      content.includes('pnpm dev:local'),
      'development workflow must surface `pnpm dev:local` (the recommended local entry; see scripts/dev-local.ts)',
    ).toBe(true);
  });

  it('development workflow lists `pnpm dev:local` before bare `pnpm dev`', () => {
    const content = read('docs/agents/development-workflow.md');
    const localIdx = content.indexOf('pnpm dev:local');
    // The first occurrence of a bare `pnpm dev` that is NOT the `dev:local` line.
    // `pnpm dev ` (trailing space) avoids matching `pnpm dev:local`.
    const bareIdx = content.indexOf('pnpm dev ');
    expect(localIdx, 'pnpm dev:local missing from development workflow').toBeGreaterThanOrEqual(0);
    expect(bareIdx, 'bare pnpm dev missing from development workflow').toBeGreaterThanOrEqual(0);
    expect(
      localIdx,
      'pnpm dev:local should be listed before bare `pnpm dev` (dev:local is the recommended entry)',
    ).toBeLessThan(bareIdx);
  });

  // ── YUK-243 — AGENTS.md submodule count is not a stale hard-coded number ───

  it('AGENTS.md: does not hard-code the stale "22 子模块" submodule count', () => {
    const content = read('AGENTS.md');
    expect(
      content.includes('22 子模块'),
      'AGENTS.md must not claim "22 子模块" — src/server/ has more; use a dynamic phrasing instead',
    ).toBe(false);
  });

  it('AGENTS.md: server submodule line points readers at the live directory listing', () => {
    const content = read('AGENTS.md');
    // The fixed line uses a dynamic "精确数以 ls src/server/*/ 为准" phrasing so it
    // never re-drifts against a literal count.
    expect(
      content.includes('ls src/server/'),
      'AGENTS.md server line should reference `ls src/server/*/` as the authoritative count',
    ).toBe(true);
  });

  // ── YUK-244 — architecture.md §5.1 Task snapshot stays valid against taskCatalog ─

  it('docs/architecture.md: §5.1 Task table contains only live catalog kinds', () => {
    const catalogKinds = new Set(Object.keys(taskCatalog));
    const doc = read('docs/architecture.md');
    // Restrict to the §5.1 snapshot table: from its header row until the
    // "**与旧 ADR 版本差异**" marker that immediately follows it.
    const tableStart = doc.indexOf('| Task | 模型 |');
    const tableEnd = doc.indexOf('**与旧 ADR 版本差异**', tableStart);
    expect(tableStart, 'failed to locate §5.1 Task snapshot table header').toBeGreaterThanOrEqual(
      0,
    );
    expect(tableEnd, 'failed to locate the table-closing diff marker').toBeGreaterThan(tableStart);
    const tableBlock = doc.slice(tableStart, tableEnd);

    const documentedKinds = [...tableBlock.matchAll(/^\| `([A-Za-z][A-Za-z0-9]*)` \|/gm)].flatMap(
      (match) => (match[1] === undefined ? [] : [match[1]]),
    );
    const staleKinds = documentedKinds.filter((kind) => !catalogKinds.has(kind));
    expect(
      staleKinds,
      `architecture.md §5.1 contains nonexistent catalog kinds: ${staleKinds.join(', ')}`,
    ).toEqual([]);
  });

  it('docs/architecture.md: §5.1 marks itself non-exhaustive and cites the composition root', () => {
    const doc = read('docs/architecture.md');
    expect(
      doc.includes('src/ai/task-catalog.ts'),
      'architecture.md §5.1 should cite src/ai/task-catalog.ts as the canonical composition root',
    ).toBe(true);
    expect(doc.includes('src/ai/registry.ts')).toBe(true);
    expect(doc.includes('compatibility projection')).toBe(true);
    expect(
      doc.includes('不是完整清单') || doc.includes('非完整清单'),
      'architecture.md §5.1 should flag the snapshot as a non-exhaustive overview',
    ).toBe(true);
  });

  it('wires task census through the full test chain, exact-head audits, and verification docs', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.test).toContain('pnpm audit:task-census');
    expect(read('.github/workflows/ci-gate.yml')).toContain('pnpm audit:task-census');
    expect(read('docs/agents/development-workflow.md')).toContain('pnpm audit:task-census');
    expect(read('README.md')).toContain('pnpm audit:task-census');
  });
});

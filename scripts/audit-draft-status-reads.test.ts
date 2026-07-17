// YUK-569 — read-side draft-status pool-visibility audit unit test.
//
// UNIT partition: imports ONLY the pure functions from audit-draft-status-reads.ts (which pull
// in node:fs/path + the tokenizer lib — no DB / postgres / drizzle), so `pnpm audit:partition`
// keeps it in the fast no-DB lane (scripts/**/*.test.ts is on fastTestInclude).
//
// Pins (spec §8.3):
//   - D1/R1/R2 positive detection, incl. reordered or(ne,isNull) + bare-column raw form
//   - comment / string / non-sql-template PROSE is NOT flagged (tokenizer, §6.4 point 2)
//   - F2 eq()/=== 'active'/!== 'draft' guards + schema/type/projection are NOT flagged
//   - helper-def file excluded by path + sentinel-removal fails loud
//   - UNKNOWN-SHAPE emitted for a synthetic novel raw-SQL dialect
//   - allowlist hygiene rejects a malformed entry
//   - validateReadGate.ok (drives --strict exit) is false on a planted violation, true on clean
//   - real-tree baseline is clean (0 flagged, 0 UNKNOWN) — the strict-in-pnpm-test wire is safe

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HELPER_SENTINEL,
  checkHelperSentinels,
  findJsTwins,
  readFileOrNull,
  scanReads,
  validateReadGate,
  walkSource,
} from './audit-draft-status-reads';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const F = 'src/x.ts'; // a non-helper source file name for fixtures.

describe('scanReads — D1 (Drizzle or(isNull,ne)) positive detection', () => {
  it('flags the canonical shape', () => {
    const { hits, unknown } = scanReads(
      F,
      "const p = or(isNull(question.draft_status), ne(question.draft_status, 'draft'));",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].dialect).toBe('drizzle-or-isNull-ne');
    expect(unknown).toHaveLength(0);
  });

  it('flags the REORDERED shape or(ne(...), isNull(...)) (order-agnostic)', () => {
    const { hits } = scanReads(
      F,
      "const p = or(ne(q.draft_status, 'draft'), isNull(q.draft_status));",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].dialect).toBe('drizzle-or-isNull-ne');
  });

  it('flags a whitespace/newline-split shape', () => {
    const src = [
      'and(',
      '  or(',
      '    isNull(question.draft_status),',
      "    ne(question.draft_status, 'draft'),",
      '  ),',
      ')',
    ].join('\n');
    expect(scanReads(F, src).hits).toHaveLength(1);
  });
});

describe('scanReads — R1/R2 (raw SQL) positive detection', () => {
  it('flags the interpolated IS NULL OR <> draft form (R1)', () => {
    const src =
      "const q = db.execute(sql`SELECT id FROM question WHERE (${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`);";
    const { hits } = scanReads(F, src);
    expect(hits).toHaveLength(1);
    expect(hits[0].dialect).toBe('raw-is-null-or');
  });

  it('flags the BARE-column raw form (fewshot-retrieve C2 shape)', () => {
    const src =
      "const q = db.execute(sql`SELECT id FROM question WHERE (draft_status IS NULL OR draft_status <> 'draft')`);";
    const { hits } = scanReads(F, src);
    expect(hits).toHaveLength(1);
    expect(hits[0].dialect).toBe('raw-is-null-or');
  });

  it('flags IS DISTINCT FROM draft (R2)', () => {
    const src =
      "const q = db.execute(sql`SELECT id FROM question WHERE ${question.draft_status} IS DISTINCT FROM 'draft'`);";
    const { hits } = scanReads(F, src);
    expect(hits).toHaveLength(1);
    expect(hits[0].dialect).toBe('is-distinct-from');
  });
});

describe('scanReads — helper-routed migrated sites are NOT flagged', () => {
  it('ignores a plain notDraftPredicate call', () => {
    const { hits, unknown } = scanReads(F, 'const p = notDraftPredicate(question.draft_status);');
    expect(hits).toHaveLength(0);
    expect(unknown).toHaveLength(0);
  });

  it('ignores a helper-routed sql`` template', () => {
    const src =
      'const q = db.execute(sql`SELECT id FROM question WHERE ${notDraftPredicate(question.draft_status)}`);';
    const { hits, unknown } = scanReads(F, src);
    expect(hits).toHaveLength(0);
    expect(unknown).toHaveLength(0);
  });

  it('STILL flags a hand-rolled predicate coexisting with a helper call in the SAME template (mixed, CodeRabbit YUK-569)', () => {
    const src =
      "const q = db.execute(sql`SELECT id FROM question WHERE ${notDraftPredicate(question.draft_status)} AND (draft_status IS NULL OR draft_status <> 'draft')`);";
    const { hits, unknown } = scanReads(F, src);
    expect(hits).toHaveLength(1);
    expect(hits[0].dialect).toBe('raw-is-null-or');
    expect(unknown).toHaveLength(0);
  });

  it('STILL flags an UNKNOWN shape coexisting with a helper call in the SAME template (mixed)', () => {
    const src =
      "const q = db.execute(sql`SELECT id FROM question WHERE ${notDraftPredicate(question.draft_status)} AND draft_status NOT IN ('draft')`);";
    const { hits, unknown } = scanReads(F, src);
    expect(hits).toHaveLength(0);
    expect(unknown).toHaveLength(1);
  });
});

describe('scanReads — PROSE in comments / strings / non-sql templates is NOT flagged', () => {
  it('skips SQL predicate prose in a line comment', () => {
    const r = scanReads(F, "// draft_status IS NULL OR draft_status <> 'draft' — the pool filter");
    expect(r.hits).toHaveLength(0);
    expect(r.unknown).toHaveLength(0);
  });

  it('skips the DRIZZLE shape written as comment prose (codeMask guard)', () => {
    const r = scanReads(
      F,
      "// or(isNull(question.draft_status), ne(question.draft_status, 'draft'))",
    );
    expect(r.hits).toHaveLength(0);
    expect(r.unknown).toHaveLength(0);
  });

  it('skips IS DISTINCT FROM prose in a block comment', () => {
    const r = scanReads(F, "/* draft_status IS DISTINCT FROM 'draft' legacy note */");
    expect(r.hits).toHaveLength(0);
    expect(r.unknown).toHaveLength(0);
  });

  it('skips the predicate inside a NON-sql-tagged template literal', () => {
    const r = scanReads(F, "const doc = `draft_status IS NULL OR draft_status <> 'draft'`;");
    expect(r.hits).toHaveLength(0);
    expect(r.unknown).toHaveLength(0);
  });

  it('skips the predicate inside a plain double-quoted string', () => {
    const r = scanReads(F, 'const doc = "draft_status IS NULL OR draft_status <> whatever";');
    expect(r.hits).toHaveLength(0);
    expect(r.unknown).toHaveLength(0);
  });
});

describe('scanReads — family-2 gates + benign mentions are NOT flagged', () => {
  it('ignores a JS !== draft promote guard', () => {
    expect(scanReads(F, "if (row.draft_status !== 'draft') return;").hits).toHaveLength(0);
  });

  it('ignores eq(col, active) / eq(col, draft) exact-match gates', () => {
    expect(scanReads(F, "const c = eq(question.draft_status, 'active');").hits).toHaveLength(0);
    expect(scanReads(F, "const c = eq(question.draft_status, 'draft');").hits).toHaveLength(0);
  });

  it('ignores a === active UI check', () => {
    expect(scanReads(F, "if (q.draft_status === 'active') {}").hits).toHaveLength(0);
  });

  it('ignores a projection and a type declaration', () => {
    expect(scanReads(F, 'const cols = { draft_status: question.draft_status };').hits).toHaveLength(
      0,
    );
    expect(scanReads(F, 'type Row = { draft_status: string | null };').hits).toHaveLength(0);
  });
});

describe('scanReads — UNKNOWN-SHAPE backstop for novel raw-SQL dialects', () => {
  it('reports NOT IN (draft) as UNKNOWN-SHAPE', () => {
    const src =
      "const q = db.execute(sql`SELECT id FROM question WHERE ${question.draft_status} NOT IN ('draft')`);";
    const r = scanReads(F, src);
    expect(r.hits).toHaveLength(0);
    expect(r.unknown).toHaveLength(1);
  });

  it('reports coalesce(...) <> draft as UNKNOWN-SHAPE', () => {
    const src =
      "const q = db.execute(sql`SELECT id FROM question WHERE coalesce(${question.draft_status}, 'active') <> 'draft'`);";
    const r = scanReads(F, src);
    expect(r.unknown).toHaveLength(1);
  });

  it('reports IS DISTINCT FROM active (not draft) as UNKNOWN-SHAPE', () => {
    const src =
      "const q = db.execute(sql`SELECT id FROM question WHERE ${question.draft_status} IS DISTINCT FROM 'active'`);";
    const r = scanReads(F, src);
    expect(r.hits).toHaveLength(0);
    expect(r.unknown).toHaveLength(1);
  });
});

describe('scanReads — helper definition file is excluded', () => {
  it('returns nothing even for an inline predicate in the helper def file', () => {
    const r = scanReads(
      'src/db/predicates.ts',
      "export const p = or(isNull(question.draft_status), ne(question.draft_status, 'draft'));",
    );
    expect(r.hits).toHaveLength(0);
    expect(r.unknown).toHaveLength(0);
  });
});

describe('checkHelperSentinels — reverse-check fails loud', () => {
  it('passes when the sentinel marker is present', () => {
    const read = (f: string) =>
      f === 'src/db/predicates.ts' ? `${HELPER_SENTINEL}\nexport const x = 1;` : null;
    expect(checkHelperSentinels(read)).toEqual([]);
  });

  it('fails when the sentinel marker is removed', () => {
    const problems = checkHelperSentinels(() => 'export const x = 1;');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/sentinel/);
  });

  it('fails when the helper-def file is missing (renamed without updating the constant)', () => {
    const problems = checkHelperSentinels(() => null);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/missing/);
  });
});

describe('findJsTwins — informational isPoolVisible call sites (Engine B deferred)', () => {
  it('finds a live isPoolVisible call', () => {
    expect(findJsTwins(F, 'if (isPoolVisible(r)) {}')).toHaveLength(1);
  });

  it('excludes the helper-def file', () => {
    expect(findJsTwins('src/db/predicates.ts', 'isPoolVisible(row)')).toHaveLength(0);
  });

  it('ignores isPoolVisible mentioned only in a comment', () => {
    expect(findJsTwins(F, '// isPoolVisible(r) note')).toHaveLength(0);
  });
});

describe('validateReadGate — gate semantics (drives --strict exit)', () => {
  const cleanAllowlist = {
    'src/x.ts': {
      reason: 'mid-migration',
      resolves_when: { kind: 'manual' as const, ref: 'permanent', expected_by: '2027-06-30' },
    },
  };
  const hit = { file: 'src/x.ts', line: 1, dialect: 'raw-is-null-or' as const, snippet: '' };

  it('ok=true on a fully clean tree', () => {
    expect(validateReadGate([], [], {}, {}, []).ok).toBe(true);
  });

  it('ok=false on a planted F1 hit that is NOT allowlisted', () => {
    const res = validateReadGate([hit], [], {}, {}, []);
    expect(res.ok).toBe(false);
    expect(res.hits).toHaveLength(1);
  });

  it('ok=true when the F1 hit is allowlisted (hit moves to allowlisted)', () => {
    const res = validateReadGate([hit], [], cleanAllowlist, cleanAllowlist, []);
    expect(res.ok).toBe(true);
    expect(res.hits).toHaveLength(0);
    expect(res.allowlisted).toHaveLength(1);
  });

  it('ok=false when a non-allowlisted UNKNOWN-SHAPE hit is present', () => {
    const res = validateReadGate([], [{ file: 'src/x.ts', line: 2, snippet: '' }], {}, {}, []);
    expect(res.ok).toBe(false);
    expect(res.unknown).toHaveLength(1);
  });

  it('ok=true when an UNKNOWN-SHAPE hit is allowlisted (benign non-predicate read escape hatch)', () => {
    const unknownHit = [{ file: 'src/x.ts', line: 2, snippet: '' }];
    const res = validateReadGate([], unknownHit, cleanAllowlist, cleanAllowlist, []);
    expect(res.ok).toBe(true);
    expect(res.unknown).toHaveLength(0);
    expect(res.allowlistedUnknown).toHaveLength(1);
  });

  it('ok=false when a helper-def sentinel issue is present', () => {
    expect(validateReadGate([], [], {}, {}, ['src/db/predicates.ts: sentinel missing']).ok).toBe(
      false,
    );
  });

  it('rejects a malformed allowlist entry via hygiene', () => {
    const rawAllowlist = {
      'f.ts': { resolves_when: { kind: 'whenever', ref: 'x', expected_by: '2026-12-31' } },
    };
    const res = validateReadGate([], [], {}, rawAllowlist, []);
    expect(res.ok).toBe(false);
    expect(res.hygieneIssues.length).toBeGreaterThan(0);
  });
});

// Real-tree regression — the same scan the CLI runs. Post-migration the baseline is provably
// clean (spec §5), which is what makes the `--strict`-in-`pnpm test` wire non-flaky (§6.6).
describe('real-tree baseline is clean (strict-in-pnpm-test is safe)', () => {
  it('finds ZERO hand-rolled F1 inline + ZERO UNKNOWN-SHAPE across src/', () => {
    const files = walkSource(SRC_ROOT);
    const hits = [];
    const unknown = [];
    for (const file of files) {
      const src = readFileOrNull(file);
      if (src === null) continue;
      if (!src.includes('draft_status')) continue;
      const r = scanReads(file, src);
      hits.push(...r.hits);
      unknown.push(...r.unknown);
    }
    expect(hits, `unexpected F1 inline hits: ${JSON.stringify(hits, null, 2)}`).toHaveLength(0);
    expect(unknown, `unexpected UNKNOWN-SHAPE: ${JSON.stringify(unknown, null, 2)}`).toHaveLength(
      0,
    );
  });

  it('the helper definition file carries the sentinel marker', () => {
    expect(checkHelperSentinels(readFileOrNull)).toEqual([]);
  });

  it('skips a source file removed after enumeration', () => {
    expect(readFileOrNull('src/subjects/definitely-missing-yuk-613.ts')).toBeNull();
  });
});

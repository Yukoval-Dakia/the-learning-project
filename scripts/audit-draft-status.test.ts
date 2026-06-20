// YUK-350 (L4) — draft-status gate audit unit test.
//
// UNIT partition: imports ONLY the pure functions from audit-draft-status.ts (no DB /
// postgres / drizzle), so `pnpm audit:partition` keeps it in the fast no-DB lane.
//
// Pins:
//   - extractObjectBlock brace-balance (nested metadata objects, strings carrying '}',
//     line/block comments, template literals)
//   - scanQuestionInserts explicit/missing classification
//   - question_block / question_part are NOT captured (word-boundary)
//   - all 6 NULL-owners allowed + all 6 explicit-setters pass (no-false-positive
//     regression against the 12 real sites)
//   - a synthetic missing-draft_status-not-in-allowlist site is flagged
//   - an allowlisted-AND-explicit file silently passes (L2->L4 chain-merge guard)
//   - allowlist hygiene rejects a bad-shape entry

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type InsertSite,
  extractObjectBlock,
  scanQuestionInserts,
  validateAllowlistHygiene,
  validateDraftGate,
} from './audit-draft-status';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function blockFrom(src: string): string | null {
  return extractObjectBlock(src, src.indexOf('{'));
}

describe('extractObjectBlock (brace-balance)', () => {
  it('balances a flat object', () => {
    expect(blockFrom('x = { a: 1, b: 2 }')).toBe('{ a: 1, b: 2 }');
  });

  it('balances a nested metadata object', () => {
    const src = 'values({ id, metadata: { quiz_gen: { verdict: "pass" } }, kind })';
    expect(blockFrom(src)).toBe('{ id, metadata: { quiz_gen: { verdict: "pass" } }, kind }');
  });

  it('ignores braces inside single/double-quoted strings', () => {
    const src = 'values({ reason: "a } b { c", note: \'} {\' })';
    expect(blockFrom(src)).toBe('{ reason: "a } b { c", note: \'} {\' }');
  });

  it('ignores braces inside line comments', () => {
    const src = 'values({ a: 1, // trailing } brace\n b: 2 })';
    expect(blockFrom(src)).toBe('{ a: 1, // trailing } brace\n b: 2 }');
  });

  it('ignores braces inside block comments', () => {
    const src = 'values({ a: 1, /* a } b { c */ b: 2 })';
    expect(blockFrom(src)).toBe('{ a: 1, /* a } b { c */ b: 2 }');
  });

  it('counts braces inside template-literal interpolation but not literal text', () => {
    const src = 'values({ msg: `text } with ${cond ? "x" : "y"} more`, k: 1 })';
    expect(blockFrom(src)).toBe('{ msg: `text } with ${cond ? "x" : "y"} more`, k: 1 }');
  });

  it('returns null when no matching close brace', () => {
    expect(extractObjectBlock('{ a: 1', 0)).toBeNull();
  });
});

describe('scanQuestionInserts (classification)', () => {
  it('classifies explicit draft_status as present', () => {
    const sites = scanQuestionInserts(
      'f.ts',
      'await tx.insert(question).values({ id, draft_status: "draft", kind });',
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].hasDraftStatus).toBe(true);
  });

  it('classifies missing draft_status as absent', () => {
    const sites = scanQuestionInserts('f.ts', 'await tx.insert(question).values({ id, kind });');
    expect(sites).toHaveLength(1);
    expect(sites[0].hasDraftStatus).toBe(false);
  });

  it('accepts a quoted draft_status key', () => {
    const sites = scanQuestionInserts(
      'f.ts',
      'tx.insert(question).values({ id, "draft_status": "draft" });',
    );
    expect(sites[0].hasDraftStatus).toBe(true);
  });

  it('does NOT capture insert(question_block) / insert(question_part)', () => {
    const src = [
      'tx.insert(question_block).values({ id });',
      'tx.insert(question_part).values({ id });',
    ].join('\n');
    expect(scanQuestionInserts('f.ts', src)).toHaveLength(0);
  });

  it('does NOT treat draft_status_extra as the draft_status key (word-boundary)', () => {
    const sites = scanQuestionInserts(
      'f.ts',
      'tx.insert(question).values({ id, draft_status_extra: 1 });',
    );
    expect(sites[0].hasDraftStatus).toBe(false);
  });

  it('handles a realistic multi-key block with nested metadata + template prompt', () => {
    const src = [
      'await tx.insert(question).values({',
      '  id,',
      '  prompt_md: `解释 ${term} 的用法`,',
      '  metadata: { learning_item_id: liId, session_id: sId },',
      '  draft_status: "draft",',
      '  created_at: new Date(),',
      '});',
    ].join('\n');
    const sites = scanQuestionInserts('f.ts', src);
    expect(sites).toHaveLength(1);
    expect(sites[0].hasDraftStatus).toBe(true);
  });

  // F3 (YUK-350) — cross-line / chained insert forms must be scanned, not silently skipped.
  // The OLD matcher required `.values(` to immediately follow `.insert(question))` with nothing
  // between, so the idiomatic Drizzle multi-line builder chain escaped the gate entirely → a new
  // cross-line insert that forgot draft_status would pass falsely green. These pin the fix.
  it('scans a pure cross-line insert (newline between insert and values)', () => {
    const src = ['tx', '  .insert(question)', '  .values({', '    id,', '    kind,', '  });'].join(
      '\n',
    );
    const sites = scanQuestionInserts('f.ts', src);
    expect(sites).toHaveLength(1);
    // missing draft_status — and critically, it is no longer SKIPPED.
    expect(sites[0].hasDraftStatus).toBe(false);
  });

  it('scans the idiomatic Drizzle insert().values().onConflict() multiline chain', () => {
    const src = [
      'await tx',
      '  .insert(question)',
      '  .values({',
      '    id,',
      '    draft_status: "draft",',
      '  })',
      '  .onConflictDoNothing();',
    ].join('\n');
    const sites = scanQuestionInserts('f.ts', src);
    expect(sites).toHaveLength(1);
    expect(sites[0].hasDraftStatus).toBe(true);
  });

  it('scans an insert with an intermediate chained call before values', () => {
    const src = ['tx.insert(question)', '  .onConflictDoNothing()', '  .values({ id });'].join(
      '\n',
    );
    const sites = scanQuestionInserts('f.ts', src);
    expect(sites).toHaveLength(1);
    expect(sites[0].hasDraftStatus).toBe(false);
  });

  it('still EXCLUDES cross-line question_block / question_part (word-boundary holds)', () => {
    const src = [
      'tx',
      '  .insert(question_block)',
      '  .values({ id });',
      'tx',
      '  .insert(question_part)',
      '  .values({ id });',
    ].join('\n');
    expect(scanQuestionInserts('f.ts', src)).toHaveLength(0);
  });

  // YUK-395 — the values object may be wrapped in a derive helper call
  // (`.values(withAnswerClass({ ... }))`). The head matcher must look THROUGH the
  // single wrapper so the wrapped site is still scanned (otherwise the gate goes
  // falsely green with 0 sites). These pin the wrapper-aware matcher.
  it('scans a withAnswerClass-wrapped insert and classifies draft_status present', () => {
    const sites = scanQuestionInserts(
      'f.ts',
      'await tx.insert(question).values(withAnswerClass({ id, draft_status: "draft", kind }));',
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].hasDraftStatus).toBe(true);
  });

  it('scans a withAnswerClass-wrapped insert MISSING draft_status (still flagged, not skipped)', () => {
    const sites = scanQuestionInserts(
      'f.ts',
      'await tx.insert(question).values(withAnswerClass({ id, kind }));',
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].hasDraftStatus).toBe(false);
  });

  it('scans a cross-line withAnswerClass-wrapped insert', () => {
    const src = [
      'await tx.insert(question).values(',
      '  withAnswerClass({',
      '    id,',
      '    draft_status: "draft",',
      '    kind,',
      '  }),',
      ');',
    ].join('\n');
    const sites = scanQuestionInserts('f.ts', src);
    expect(sites).toHaveLength(1);
    expect(sites[0].hasDraftStatus).toBe(true);
  });

  it('counts two distinct cross-line question inserts separately', () => {
    const src = [
      'await tx',
      '  .insert(question)',
      '  .values({ a: 1 });',
      'await db',
      '  .insert(question)',
      '  .values({ b: 2 });',
    ].join('\n');
    const sites = scanQuestionInserts('f.ts', src);
    expect(sites).toHaveLength(2);
  });
});

// No-false-positive regression — run the REAL scanner over the real source sites.
const REAL_SETTERS = [
  'src/capabilities/ingestion/server/image-candidate-accept.ts',
  'src/capabilities/practice/server/proposal-appliers.ts',
  'src/server/boss/handlers/sourcing.ts',
  'src/server/ai/question-author.ts',
  'src/server/boss/handlers/quiz_gen.ts',
  'src/server/proposals/legacy-record-appliers.ts',
  // post-L2 explicit setters (also allowlisted, harmless-redundant):
  // (YUK-358 决定3: embedded_check_generate.ts removed with the orphan chain.)
  'src/capabilities/copilot/server/teaching/materialize-ask-check.ts',
];
const REAL_NULL_OWNERS = [
  'src/capabilities/ingestion/server/auto-enroll.ts',
  'src/capabilities/ingestion/api/import.ts',
  'src/capabilities/ingestion/api/mistakes.ts',
  'src/server/questions/parts.ts',
];

describe('no-false-positive regression (real sites)', () => {
  it('every explicit-setter site is detected as carrying draft_status', () => {
    for (const file of REAL_SETTERS) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf-8');
      const sites = scanQuestionInserts(file, src).filter((s) => s.file === file);
      const questionSites = sites.length;
      expect(questionSites).toBeGreaterThan(0);
      // every question-insert in a setter file carries draft_status.
      expect(sites.every((s) => s.hasDraftStatus)).toBe(true);
    }
  });

  it('every NULL-owner site is detected as MISSING draft_status (so the allowlist is load-bearing)', () => {
    for (const file of REAL_NULL_OWNERS) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf-8');
      const sites = scanQuestionInserts(file, src);
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.every((s) => !s.hasDraftStatus)).toBe(true);
    }
  });
});

describe('validateDraftGate (gate semantics)', () => {
  const allowlist = {
    'src/capabilities/ingestion/server/auto-enroll.ts': {
      reason: 'r',
      resolves_when: { kind: 'manual' as const, ref: 'x', expected_by: '2027-06-30' },
    },
  };
  const rawAllowlist = allowlist;

  it('passes when every site has draft_status', () => {
    const sites: InsertSite[] = [{ file: 'a.ts', line: 1, hasDraftStatus: true }];
    const res = validateDraftGate(sites, {}, {});
    expect(res.ok).toBe(true);
    expect(res.flagged).toHaveLength(0);
  });

  it('flags a missing draft_status site that is NOT allowlisted', () => {
    const sites: InsertSite[] = [{ file: 'rogue.ts', line: 9, hasDraftStatus: false }];
    const res = validateDraftGate(sites, allowlist, rawAllowlist);
    expect(res.ok).toBe(false);
    expect(res.flagged.map((f) => f.file)).toEqual(['rogue.ts']);
  });

  it('allows a missing draft_status site that IS allowlisted', () => {
    const sites: InsertSite[] = [
      { file: 'src/capabilities/ingestion/server/auto-enroll.ts', line: 1, hasDraftStatus: false },
    ];
    const res = validateDraftGate(sites, allowlist, rawAllowlist);
    expect(res.ok).toBe(true);
    expect(res.allowlistedHits).toContain('src/capabilities/ingestion/server/auto-enroll.ts');
  });

  it('silently passes an allowlisted-AND-explicit file (L2->L4 chain-merge guard)', () => {
    const sites: InsertSite[] = [
      { file: 'src/capabilities/ingestion/server/auto-enroll.ts', line: 1, hasDraftStatus: true },
    ];
    const res = validateDraftGate(sites, allowlist, rawAllowlist);
    expect(res.ok).toBe(true);
    // has draft_status → not even counted as an allowlisted hit; it just passes.
    expect(res.flagged).toHaveLength(0);
  });
});

describe('validateAllowlistHygiene', () => {
  it('accepts a well-formed entry', () => {
    const raw = {
      _comment: 'doc',
      'f.ts': {
        reason: 'because',
        resolves_when: { kind: 'manual', ref: 'permanent', expected_by: '2027-06-30' },
      },
    };
    expect(validateAllowlistHygiene(raw)).toHaveLength(0);
  });

  it('rejects a missing reason', () => {
    const raw = {
      'f.ts': { resolves_when: { kind: 'pr', ref: '#1', expected_by: '2026-12-31' } },
    };
    expect(validateAllowlistHygiene(raw).some((i) => /reason/.test(i.problem))).toBe(true);
  });

  it('rejects an invalid kind', () => {
    const raw = {
      'f.ts': {
        reason: 'r',
        resolves_when: { kind: 'whenever', ref: 'x', expected_by: '2026-12-31' },
      },
    };
    expect(validateAllowlistHygiene(raw).some((i) => /kind/.test(i.problem))).toBe(true);
  });

  it('rejects a bad expected_by date', () => {
    const raw = {
      'f.ts': { reason: 'r', resolves_when: { kind: 'manual', ref: 'x', expected_by: 'soon' } },
    };
    expect(validateAllowlistHygiene(raw).some((i) => /expected_by/.test(i.problem))).toBe(true);
  });

  it('validates the SHIPPED allowlist file shape', () => {
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts/audit-draft-status-allowlist.json'), 'utf-8'),
    );
    expect(validateAllowlistHygiene(raw)).toHaveLength(0);
  });
});

// YUK-569 — Drizzle compiled-SQL shape assertion for notDraftPredicate (src/db/predicates.ts).
//
// DB partition: imports drizzle-orm (PgDialect) + @/db/schema, so it falls through
// allTestInclude's `src/**/*.test.ts` glob into the db lane (audit:partition keeps drizzle-orm
// imports OUT of the unit partition). It compiles the fragment with PgDialect — PURE, no live
// Postgres, no resetDb — asserting the emitted SQL IS the canonical NULL-safe fail-open
// blocklist `draft_status IS NULL OR draft_status <> 'draft'` that the JS twin models (the JS
// truth table + equivalence live in the sibling unit test predicates.test.ts). This is the
// SQL-side half of the §8.1 equivalence: emitted SQL == the model == isPoolVisible.

import { notDraftPredicate } from '@/db/predicates';
import { question } from '@/db/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

describe('notDraftPredicate — compiled SQL shape (§5.1 canonical NULL-safe blocklist)', () => {
  const { sql, params } = new PgDialect().sqlToQuery(notDraftPredicate(question.draft_status));
  const lower = sql.toLowerCase();

  it('references the fully-qualified draft_status column on both operands', () => {
    const occurrences = lower.split('"question"."draft_status"').length - 1;
    expect(occurrences).toBe(2);
  });

  it('is the fail-open blocklist: IS NULL OR <> $draft', () => {
    expect(lower).toContain('"question"."draft_status" is null');
    expect(lower).toContain(' or ');
    expect(lower).toContain('"question"."draft_status" <> ');
    expect(params).toContain('draft');
  });

  it('never hard-excludes NULL — the load-bearing IS NULL disjunct precedes OR (§5.2)', () => {
    // A bare `<> 'draft'` would fail-closed on NULL under 3-valued logic; the compiled form
    // MUST carry the IS NULL rescue disjunct.
    expect(lower).toMatch(/is null\s+or/);
  });
});

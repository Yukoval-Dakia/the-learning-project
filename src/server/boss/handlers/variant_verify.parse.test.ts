// YUK-299 — three-state dispatch unit for parseVariantVerifyResult.
//
// The function itself is pure (no DB), but importing ./variant_verify pulls in
// @/server/events/queries → @/db/client (eager connection at module load). Per
// the partition auditor (DB_TAINTED_DIRS includes src/server/boss/), this file
// classifies as the db partition: the testcontainer is up and DATABASE_URL is
// injected, so the import chain is safe. We deliberately do NOT split
// parseVariantVerifyResult into a DB-free file just to win a unit-partition slot
// (that would distort the production structure for a test — §5.3 of the plan).
//
// The end-to-end verdict → mistake_variant.status='broken' flow stays covered by
// the sibling variant_verify.test.ts (db partition); this file only exercises the
// three-state parse seam.

import type { TaskTextResult } from '@/server/ai/provenance';
import { describe, expect, it } from 'vitest';
import { parseVariantVerifyResult } from './variant_verify';

const VALID_STRUCTURED = {
  verdict: 'pass' as const,
  failure_reasons: [],
  cause_targeting: 'on_target' as const,
  summary_md: '变式覆盖了"之-主谓间"概念，难度与原题接近。',
  confidence: 0.82,
};

function asResult(over: Partial<TaskTextResult>): TaskTextResult {
  return { text: '', ...over };
}

describe('parseVariantVerifyResult — YUK-299 three-state dispatch', () => {
  it('(A) parses a schema-valid structured_output without char-scanning', () => {
    const parsed = parseVariantVerifyResult(
      // text is intentionally non-JSON: if the structured path were skipped, the
      // char-scan fallback would throw — proving (A) does not touch result.text.
      asResult({ structured_output: VALID_STRUCTURED, text: 'NOT JSON AT ALL' }),
    );
    expect(parsed.verdict).toBe('pass');
    expect(parsed.cause_targeting).toBe('on_target');
  });

  it("(A') throws when structured_output is shape-valid but violates a business constraint (maxItems)", () => {
    const tooMany = {
      ...VALID_STRUCTURED,
      verdict: 'fail' as const,
      cause_targeting: 'off_target' as const,
      failure_reasons: Array.from({ length: 11 }, (_, i) => `reason ${i}`),
    };
    expect(() =>
      parseVariantVerifyResult(asResult({ structured_output: tooMany, text: '' })),
    ).toThrow(/schema invalid/);
  });

  it("(A'') re-applies .default([]) when structured_output omits failure_reasons", () => {
    const omitted = {
      verdict: 'pass' as const,
      cause_targeting: 'on_target' as const,
      summary_md: '变式无需列举失败原因。',
      confidence: 0.7,
    };
    const parsed = parseVariantVerifyResult(asResult({ structured_output: omitted, text: '' }));
    expect(parsed.failure_reasons).toEqual([]);
  });

  it('(B) falls back to the char-scan parse when structured_output is undefined', () => {
    const text = `prefix noise ${JSON.stringify(VALID_STRUCTURED)} trailing noise`;
    const parsed = parseVariantVerifyResult(asResult({ text }));
    expect(parsed.verdict).toBe('pass');
  });

  it("(B') fallback still throws on dirty text (defensive layer intact)", () => {
    expect(() => parseVariantVerifyResult(asResult({ text: 'no json here' }))).toThrow();
  });
});

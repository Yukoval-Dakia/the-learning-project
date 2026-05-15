import { describe, expect, it } from 'vitest';
import { FK_ORDER, MAX_INLINE_ASSETS, SCHEMA_VERSION } from './constants';

describe('export constants', () => {
  it('SCHEMA_VERSION is "1.0"', () => {
    expect(SCHEMA_VERSION).toBe('1.0');
  });

  it('MAX_INLINE_ASSETS is 45 (CF Worker free 50 sub-request budget)', () => {
    expect(MAX_INLINE_ASSETS).toBe(45);
  });

  it('FK_ORDER lists all 16 tables in topological order', () => {
    // 18 → 16: judgment + user_appeal DROPped in Phase 1c.1 Step 1.4 (Lane A)
    // per ADR-0006 v2 / data-assumptions §O2.
    expect(FK_ORDER.length).toBe(16);
    expect(FK_ORDER[0]).toBe('knowledge');
    expect(FK_ORDER[FK_ORDER.length - 1]).toBe('cost_ledger');
  });

  it('FK_ORDER respects dependencies (parent before child)', () => {
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    expect(idx('question')).toBeLessThan(idx('mistake'));
    expect(idx('mistake')).toBeLessThan(idx('review_event'));
    expect(idx('source_asset')).toBeLessThan(idx('source_document'));
    expect(idx('source_document')).toBeLessThan(idx('ingestion_session'));
    expect(idx('ingestion_session')).toBeLessThan(idx('question_block'));
    expect(idx('mistake')).toBeLessThan(idx('completion_evidence'));
  });

  it('FK_ORDER has no duplicates', () => {
    expect(new Set(FK_ORDER).size).toBe(FK_ORDER.length);
  });
});

import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, MAX_INLINE_ASSETS, FK_ORDER } from './constants';

describe('export constants', () => {
  it('SCHEMA_VERSION is "1.0"', () => {
    expect(SCHEMA_VERSION).toBe('1.0');
  });

  it('MAX_INLINE_ASSETS is 45 (CF Worker free 50 sub-request budget)', () => {
    expect(MAX_INLINE_ASSETS).toBe(45);
  });

  it('FK_ORDER lists all 18 tables in topological order', () => {
    expect(FK_ORDER.length).toBe(18);
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

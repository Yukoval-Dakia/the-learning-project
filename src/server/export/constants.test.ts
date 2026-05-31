import { describe, expect, it } from 'vitest';
import { FK_ORDER, MAX_INLINE_ASSETS, SCHEMA_VERSION } from './constants';

describe('export constants', () => {
  it('SCHEMA_VERSION is "4.1" (P5.3: additive nullable memory_brief_note.long_term_freshness_score column)', () => {
    expect(SCHEMA_VERSION).toBe('4.1');
  });

  it('MAX_INLINE_ASSETS is 45 (legacy CF Worker 50 sub-request guardrail)', () => {
    expect(MAX_INLINE_ASSETS).toBe(45);
  });

  it('FK_ORDER lists all 17 tables in topological order', () => {
    // 16 → 17: learning_record loop dropped study_log (-1) and added
    // learning_record + memory_brief_note (+2). knowledge_mastery view is
    // read-only and excluded.
    expect(FK_ORDER.length).toBe(17);
    expect(FK_ORDER[0]).toBe('knowledge');
    expect(FK_ORDER[FK_ORDER.length - 1]).toBe('cost_ledger');
  });

  it('FK_ORDER respects dependencies (parent before child)', () => {
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    expect(idx('source_asset')).toBeLessThan(idx('source_document'));
    expect(idx('source_document')).toBeLessThan(idx('question_block'));
    expect(idx('knowledge')).toBeLessThan(idx('knowledge_edge'));
    expect(idx('learning_session')).toBeLessThan(idx('event'));
  });

  it('FK_ORDER includes all Phase 1c.1 Lane A new tables', () => {
    expect(FK_ORDER).toContain('knowledge_edge');
    expect(FK_ORDER).toContain('learning_session');
    expect(FK_ORDER).toContain('material_fsrs_state');
    expect(FK_ORDER).toContain('event');
  });

  it('FK_ORDER excludes Step 1.4 DROPped tables (judgment, user_appeal)', () => {
    expect(FK_ORDER).not.toContain('judgment');
    expect(FK_ORDER).not.toContain('user_appeal');
  });

  it('FK_ORDER excludes Step 9.J DROPped legacy tables (mistake / review_event / dreaming_proposal / ingestion_session)', () => {
    expect(FK_ORDER).not.toContain('mistake');
    expect(FK_ORDER).not.toContain('review_event');
    expect(FK_ORDER).not.toContain('dreaming_proposal');
    expect(FK_ORDER).not.toContain('ingestion_session');
  });

  it('FK_ORDER excludes views (knowledge_mastery)', () => {
    expect(FK_ORDER).not.toContain('knowledge_mastery');
  });

  it('FK_ORDER has no duplicates', () => {
    expect(new Set(FK_ORDER).size).toBe(FK_ORDER.length);
  });
});

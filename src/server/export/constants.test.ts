import { describe, expect, it } from 'vitest';
import { FK_ORDER, MAX_INLINE_ASSETS, SCHEMA_VERSION } from './constants';

describe('export constants', () => {
  it('SCHEMA_VERSION is "2.0" (Phase 1c.1 breaking change — event core + DROPs)', () => {
    expect(SCHEMA_VERSION).toBe('2.0');
  });

  it('MAX_INLINE_ASSETS is 45 (legacy CF Worker 50 sub-request guardrail)', () => {
    expect(MAX_INLINE_ASSETS).toBe(45);
  });

  it('FK_ORDER lists all 20 tables in topological order', () => {
    // 16 → 20: Phase 1c.1 Lane A added 4 (knowledge_edge, learning_session,
    // material_fsrs_state, event). knowledge_mastery view is read-only and excluded.
    expect(FK_ORDER.length).toBe(20);
    expect(FK_ORDER[0]).toBe('knowledge');
    expect(FK_ORDER[FK_ORDER.length - 1]).toBe('cost_ledger');
  });

  it('FK_ORDER respects dependencies (parent before child)', () => {
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    // Legacy
    expect(idx('question')).toBeLessThan(idx('mistake'));
    expect(idx('mistake')).toBeLessThan(idx('review_event'));
    expect(idx('source_asset')).toBeLessThan(idx('source_document'));
    expect(idx('source_document')).toBeLessThan(idx('ingestion_session'));
    expect(idx('ingestion_session')).toBeLessThan(idx('question_block'));
    expect(idx('mistake')).toBeLessThan(idx('completion_evidence'));
    // Phase 1c.1 Lane A additions
    expect(idx('knowledge')).toBeLessThan(idx('knowledge_edge')); // edge FKs to knowledge
    expect(idx('learning_session')).toBeLessThan(idx('event')); // event.session_id FK
  });

  it('FK_ORDER includes all Phase 1c.1 Lane A new tables', () => {
    expect(FK_ORDER).toContain('knowledge_edge');
    expect(FK_ORDER).toContain('learning_session');
    expect(FK_ORDER).toContain('material_fsrs_state');
    expect(FK_ORDER).toContain('event');
  });

  it('FK_ORDER excludes DROPped tables (judgment, user_appeal)', () => {
    expect(FK_ORDER).not.toContain('judgment');
    expect(FK_ORDER).not.toContain('user_appeal');
  });

  it('FK_ORDER excludes views (knowledge_mastery)', () => {
    expect(FK_ORDER).not.toContain('knowledge_mastery');
  });

  it('FK_ORDER has no duplicates', () => {
    expect(new Set(FK_ORDER).size).toBe(FK_ORDER.length);
  });
});

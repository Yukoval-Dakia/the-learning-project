// Phase 1c.1 Step 9.E — CSV exporters over event stream only.

import { describe, expect, it } from 'vitest';
import { type Row, buildMistakesCsv, buildReviewEventsCsv, csvEscape } from './csv';

describe('csvEscape', () => {
  it('returns empty string for null/undefined', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('passes through plain strings unmodified', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('123')).toBe('123');
  });

  it('coerces numbers to strings', () => {
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape(0)).toBe('0');
  });

  it('quotes strings containing comma', () => {
    expect(csvEscape('a, b')).toBe('"a, b"');
  });

  it('quotes strings containing double-quote and escapes inner quotes', () => {
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('quotes strings containing newline', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('quotes strings containing carriage return', () => {
    expect(csvEscape('line1\rline2')).toBe('"line1\rline2"');
  });
});

describe('buildMistakesCsv', () => {
  function fixture() {
    return {
      knowledge: [
        { id: 'k1', name: '虚词' },
        { id: 'k2', name: '实词' },
      ],
      question: [
        {
          id: 'q1',
          prompt_md: '解释"之"的用法',
          reference_md: '助词；代词；动词',
          knowledge_ids: '["k1"]',
          difficulty: 4,
        },
      ],
      event: [
        // Attempt event (failure on q1)
        {
          id: 'evt_attempt_1',
          action: 'attempt',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'failure',
          payload:
            '{"answer_md":"只记得 代词","answer_image_refs":[],"referenced_knowledge_ids":["k1","k2"]}',
          caused_by_event_id: null,
          created_at: 1699000000,
        },
        // Chained judge with cause
        {
          id: 'evt_judge_1',
          action: 'judge',
          subject_kind: 'event',
          subject_id: 'evt_attempt_1',
          outcome: 'success',
          payload:
            '{"cause":{"primary_category":"knowledge_gap","secondary_categories":[],"analysis_md":"需要复习","confidence":0.7},"referenced_knowledge_ids":["k1"]}',
          caused_by_event_id: 'evt_attempt_1',
          created_at: 1699003600,
        },
        // Review event for last_review tracking
        {
          id: 'evt_review_1',
          action: 'review',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'success',
          payload:
            '{"fsrs_rating":"good","fsrs_state_after":{"due":1700200000,"stability":2,"difficulty":5,"scheduled_days":3,"learning_steps":0,"reps":3,"lapses":1,"state":"review","last_review":1700100000},"user_response_md":null,"referenced_knowledge_ids":[]}',
          caused_by_event_id: null,
          created_at: 1700200000,
        },
      ] as Row[],
      material_fsrs_state: [
        {
          subject_kind: 'question',
          subject_id: 'q1',
          state:
            '{"due":1700000000,"stability":2,"difficulty":5,"reps":3,"lapses":1,"state":"review"}',
        },
      ] as Row[],
    };
  }

  it('renders header line + one row per failure attempt', () => {
    const csv = buildMistakesCsv(fixture());
    const lines = csv.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('id,created_at,prompt_md');
    expect(lines[0]).toContain('knowledge_names');
  });

  it('joins knowledge_names by "; " using knowledge.name lookup', () => {
    const csv = buildMistakesCsv(fixture());
    expect(csv).toContain('虚词; 实词');
  });

  it('includes judge cause primary_category in projected row', () => {
    const csv = buildMistakesCsv(fixture());
    expect(csv).toContain('knowledge_gap');
  });

  it('decomposes fsrs_state JSON columns from material_fsrs_state', () => {
    const csv = buildMistakesCsv(fixture());
    expect(csv).toContain('1700000000');
    expect(csv).toContain(',3,'); // reps
    expect(csv).toContain(',1,'); // lapses
  });

  it('counts review events per question as last_reviewed_at / review_count', () => {
    const csv = buildMistakesCsv(fixture());
    const dataLine = csv.split('\n')[1];
    const cols = dataLine.split(',');
    expect(cols[cols.length - 2]).toBe('1700200000');
    expect(cols[cols.length - 1]).toBe('1');
  });

  it('handles missing judge gracefully (cause blank)', () => {
    const tables = fixture();
    tables.event = tables.event.filter((e) => e.action !== 'judge');
    const csv = buildMistakesCsv(tables);
    expect(csv.split('\n').length).toBe(2);
  });

  it('handles no review events (review_count=0, last_reviewed_at empty)', () => {
    const tables = fixture();
    tables.event = tables.event.filter((e) => e.action !== 'review');
    const csv = buildMistakesCsv(tables);
    const cols = csv.split('\n')[1].split(',');
    expect(cols[cols.length - 2]).toBe('');
    expect(cols[cols.length - 1]).toBe('0');
  });
});

describe('buildReviewEventsCsv', () => {
  function fixture() {
    return {
      knowledge: [{ id: 'k1', name: '虚词' }],
      question: [
        {
          id: 'q1',
          prompt_md: '解释 之 的用法',
          knowledge_ids: '["k1"]',
        },
      ],
      event: [
        {
          id: 'evt_review_1',
          action: 'review',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'failure',
          payload:
            '{"fsrs_rating":"again","fsrs_state_after":{"stability":1.5,"difficulty":7,"due":1700200000,"state":"learning","reps":1,"lapses":1,"scheduled_days":0,"learning_steps":1,"last_review":1700100000},"user_response_md":null,"referenced_knowledge_ids":[]}',
          caused_by_event_id: null,
          created_at: 1700100000,
        },
      ] as Row[],
    };
  }

  it('renders header + 1 row per review event', () => {
    const csv = buildReviewEventsCsv(fixture());
    const lines = csv.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('created_at,mistake_id,prompt_excerpt');
    expect(lines[0]).toContain('rating');
    expect(lines[0]).toContain('due_at_next');
  });

  it('rating column outputs the text label directly (again/hard/good)', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain(',again,');
  });

  it('decomposes fsrs_state_after JSON columns', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain('1.5');
    expect(csv).toContain('1700200000');
  });

  it('handles missing fsrs_state_after gracefully', () => {
    const f = fixture();
    f.event[0].payload = '{"fsrs_rating":"again"}';
    const csv = buildReviewEventsCsv(f);
    expect(csv.split('\n').length).toBe(2);
  });

  it('joins knowledge_names from question.knowledge_ids', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain('虚词');
  });
});

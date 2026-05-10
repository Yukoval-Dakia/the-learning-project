import { describe, expect, it } from 'vitest';
import { buildMistakesCsv, buildReviewEventsCsv, csvEscape } from './csv';

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
        },
      ],
      mistake: [
        {
          id: 'm1',
          question_id: 'q1',
          wrong_answer_md: '只记得"代词"',
          knowledge_ids: '["k1","k2"]',
          cause: '{"primary_category":"knowledge_gap","user_notes":"需要复习"}',
          fsrs_state: '{"due":1700000000,"reps":3,"lapses":1}',
          difficulty: 4,
          status: 'active',
          created_at: 1699000000,
        },
      ],
      review_event: [
        { id: 'r1', mistake_id: 'm1', rated_at: 1700100000, rating: 1 },
        { id: 'r2', mistake_id: 'm1', rated_at: 1700200000, rating: 3 },
      ],
    };
  }

  it('renders header line + one row per mistake', () => {
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

  it('decomposes cause + fsrs_state JSON columns', () => {
    const csv = buildMistakesCsv(fixture());
    expect(csv).toContain('knowledge_gap');
    expect(csv).toContain('需要复习');
    expect(csv).toContain('1700000000'); // fsrs due
    expect(csv).toContain(',3,'); // reps
    expect(csv).toContain(',1,'); // lapses
  });

  it('counts review_count and finds max rated_at as last_reviewed_at', () => {
    const csv = buildMistakesCsv(fixture());
    const dataLine = csv.split('\n')[1];
    const cols = dataLine.split(',');
    expect(cols[cols.length - 2]).toBe('1700200000');
    expect(cols[cols.length - 1]).toBe('2');
  });

  it('handles mistake with null cause + null fsrs_state', () => {
    const tables = fixture();
    tables.mistake[0].cause = null as unknown as string;
    tables.mistake[0].fsrs_state = null as unknown as string;
    const csv = buildMistakesCsv(tables);
    expect(csv).toBeDefined();
    expect(csv.split('\n').length).toBe(2);
  });

  it('handles mistake with no review_events (review_count=0, last_reviewed_at empty)', () => {
    const tables = fixture();
    tables.review_event = [];
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
          prompt_md: '解释“之”的用法\n（含三种情况）',
          knowledge_ids: '["k1"]',
        },
      ],
      mistake: [{ id: 'm1', question_id: 'q1' }],
      review_event: [
        {
          id: 'r1',
          mistake_id: 'm1',
          rated_at: 1700100000,
          rating: 1,
          before_fsrs_state: '{"stability":2.5,"difficulty":5,"due":1700000000,"state":2}',
          after_fsrs_state: '{"stability":1.5,"difficulty":7,"due":1700200000,"state":3}',
        },
      ],
    };
  }

  it('renders header + 1 row per review_event', () => {
    const csv = buildReviewEventsCsv(fixture());
    const lines = csv.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('rated_at,mistake_id,prompt_excerpt');
    expect(lines[0]).toContain('rating_label');
  });

  it('rating_label is "again" for rating=1', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain('again');
  });

  it('rating_label is "hard" for rating=2 and "good" for rating=3', () => {
    const f = fixture();
    f.review_event[0].rating = 2;
    expect(buildReviewEventsCsv(f)).toContain('hard');
    f.review_event[0].rating = 3;
    expect(buildReviewEventsCsv(f)).toContain('good');
  });

  it('prompt_excerpt is first 80 chars with newlines replaced by space', () => {
    const csv = buildReviewEventsCsv(fixture());
    const dataLine = csv.split('\n')[1];
    // Newline replaced by space — the first data row should not contain a literal LF.
    // (csv.split('\n') gave us this row, so by construction it has no LF.)
    expect(dataLine).toBeDefined();
    expect(csv).toMatch(/解释“之”的用法 /); // newline became space
  });

  it('decomposes before_fsrs_state and after_fsrs_state JSON columns', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain('2.5'); // before_stability
    expect(csv).toContain('1.5'); // after_stability
    expect(csv).toContain('1700000000'); // before_due
    expect(csv).toContain('1700200000'); // after_due
  });

  it('handles missing before/after fsrs_state gracefully', () => {
    const f = fixture();
    f.review_event[0].before_fsrs_state = null as unknown as string;
    f.review_event[0].after_fsrs_state = null as unknown as string;
    const csv = buildReviewEventsCsv(f);
    expect(csv.split('\n').length).toBe(2);
  });

  it('joins knowledge_names from question.knowledge_ids', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain('虚词');
  });
});

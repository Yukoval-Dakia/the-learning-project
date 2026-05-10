import { describe, it, expect } from 'vitest';
import { csvEscape, buildMistakesCsv } from './csv';

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

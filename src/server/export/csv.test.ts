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
          difficulty: 4, // moved here — difficulty lives on question, not mistake
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
          // NOTE: no `difficulty` here — it's on question
          status: 'active',
          created_at: 1699000000,
        },
      ],
      review_event: [
        { id: 'r1', mistake_id: 'm1', created_at: 1700100000, rating: 'again' },
        { id: 'r2', mistake_id: 'm1', created_at: 1700200000, rating: 'good' },
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
          created_at: 1700100000, // was rated_at
          rating: 'again', // string label, not numeric
          fsrs_state_before: '{"stability":2.5,"difficulty":5,"due":1700000000,"state":2}', // was before_fsrs_state
          fsrs_state_after: '{"stability":1.5,"difficulty":7,"due":1700200000,"state":3}', // was after_fsrs_state
          due_at_before: 1700000000,
          due_at_next: 1700200000,
        },
      ],
    };
  }

  it('renders header + 1 row per review_event', () => {
    const csv = buildReviewEventsCsv(fixture());
    const lines = csv.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('created_at,mistake_id,prompt_excerpt');
    expect(lines[0]).toContain('rating');
    expect(lines[0]).toContain('due_at_next');
  });

  it('rating column outputs the text label directly (again/hard/good)', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain(',again,'); // rating column value
  });

  it('rating "hard" and "good" pass through', () => {
    const f1 = fixture();
    f1.review_event[0].rating = 'hard';
    expect(buildReviewEventsCsv(f1)).toContain(',hard,');
    const f2 = fixture();
    f2.review_event[0].rating = 'good';
    expect(buildReviewEventsCsv(f2)).toContain(',good,');
  });

  it('prompt_excerpt is first 80 chars with newlines replaced by space', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toMatch(/解释“之”的用法 /);
  });

  it('decomposes fsrs_state_before and fsrs_state_after JSON columns', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain('2.5');
    expect(csv).toContain('1.5');
    expect(csv).toContain('1700000000');
    expect(csv).toContain('1700200000');
  });

  it('handles missing fsrs_state_before/after gracefully', () => {
    const f = fixture();
    f.review_event[0].fsrs_state_before = null as unknown as string;
    f.review_event[0].fsrs_state_after = null as unknown as string;
    const csv = buildReviewEventsCsv(f);
    expect(csv.split('\n').length).toBe(2);
  });

  it('joins knowledge_names from question.knowledge_ids', () => {
    const csv = buildReviewEventsCsv(fixture());
    expect(csv).toContain('虚词');
  });
});

// ====================================================================
// Phase 1c.1 Step 4 — dual-path tests (legacy mistake[] OR new event[]).
// Precedence: legacy `mistake[]` wins when non-empty; else event projection.
// ====================================================================

describe('buildMistakesCsv (event-stream path)', () => {
  function eventStreamFixture() {
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
      // No legacy mistake rows → event projection takes over
      mistake: [] as Row[],
      review_event: [] as Row[],
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
        // Review events for fsrs state + last_review tracking
        {
          id: 'evt_review_1',
          action: 'review',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'success',
          payload:
            '{"fsrs_rating":"good","fsrs_state_after":{"due":1700200000,"stability":2,"difficulty":5,"scheduled_days":3,"learning_steps":0,"reps":3,"lapses":1,"state":"review","last_review":1700100000,"referenced_knowledge_ids":[]},"user_response_md":null,"referenced_knowledge_ids":[]}',
          caused_by_event_id: null,
          created_at: 1700200000,
        },
      ],
      material_fsrs_state: [
        {
          subject_kind: 'question',
          subject_id: 'q1',
          state:
            '{"due":1700200000,"stability":2,"difficulty":5,"reps":3,"lapses":1,"state":"review"}',
        },
      ],
    };
  }

  it('renders header + one row per failure attempt (event projection)', () => {
    const csv = buildMistakesCsv(eventStreamFixture());
    const lines = csv.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('id,created_at,prompt_md');
  });

  it('includes judge cause primary_category in projected row', () => {
    const csv = buildMistakesCsv(eventStreamFixture());
    expect(csv).toContain('knowledge_gap');
  });

  it('legacy `mistake[]` non-empty wins over event projection (precedence rule)', () => {
    const f = eventStreamFixture();
    f.mistake = [
      {
        id: 'm_legacy',
        question_id: 'q1',
        wrong_answer_md: 'legacy answer',
        knowledge_ids: '["k1"]',
        cause: '{"primary_category":"concept","user_notes":"legacy"}',
        fsrs_state: '{"due":1700000000,"reps":3,"lapses":1}',
        status: 'active',
        created_at: 1699000000,
      },
    ];
    const csv = buildMistakesCsv(f);
    expect(csv).toContain('m_legacy');
    expect(csv).not.toContain('evt_attempt_1');
  });
});

describe('buildReviewEventsCsv (event-stream path)', () => {
  function reviewEventStreamFixture() {
    return {
      knowledge: [{ id: 'k1', name: '虚词' }],
      question: [
        {
          id: 'q1',
          prompt_md: '解释 之 的用法',
          knowledge_ids: '["k1"]',
        },
      ],
      mistake: [] as Row[],
      review_event: [] as Row[],
      event: [
        {
          id: 'evt_review_1',
          action: 'review',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'failure',
          payload:
            '{"fsrs_rating":"again","fsrs_state_after":{"stability":1.5,"difficulty":7,"due":1700200000,"state":"learning","reps":1,"lapses":1,"scheduled_days":0,"learning_steps":1,"last_review":1700100000,"referenced_knowledge_ids":[]},"user_response_md":null,"referenced_knowledge_ids":[]}',
          caused_by_event_id: null,
          created_at: 1700100000,
        },
      ],
    };
  }

  it('renders header + one row per review event (event projection)', () => {
    const csv = buildReviewEventsCsv(reviewEventStreamFixture());
    const lines = csv.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('created_at,mistake_id,prompt_excerpt');
  });

  it('outputs fsrs_rating text label in rating column', () => {
    const csv = buildReviewEventsCsv(reviewEventStreamFixture());
    expect(csv).toContain(',again,');
  });

  it('legacy `review_event[]` non-empty wins over event projection', () => {
    const f = reviewEventStreamFixture();
    f.review_event = [
      {
        id: 'r1',
        mistake_id: 'm1',
        created_at: 1700100000,
        rating: 'good',
        fsrs_state_before: '{"stability":2.5,"difficulty":5,"due":1700000000,"state":2}',
        fsrs_state_after: '{"stability":3,"difficulty":4,"due":1700200000,"state":3}',
        due_at_before: 1700000000,
        due_at_next: 1700200000,
      },
    ];
    const csv = buildReviewEventsCsv(f);
    expect(csv).toContain('r1');
    expect(csv).toContain(',good,');
  });
});

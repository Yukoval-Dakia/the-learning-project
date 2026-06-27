import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_PAYLOAD_KIND_BY_QUESTION_KIND,
  AttemptPayload,
  type AttemptPayloadKindT,
  attemptPayloadSchemaForKind,
  expectedAttemptPayloadKind,
  parseAttemptPayloadForKind,
  safeParseAttemptPayloadForKind,
} from './attempt-payload';
import { QuestionKind } from './business';
import { AttemptOnQuestion } from './event/known';

type QuestionKindT = (typeof QuestionKind.options)[number];

describe('AttemptPayload discriminated union', () => {
  it('accepts each objective + free_text archetype', () => {
    expect(AttemptPayload.parse({ kind: 'choice', selected: ['A', 'C'] })).toEqual({
      kind: 'choice',
      selected: ['A', 'C'],
    });
    expect(AttemptPayload.parse({ kind: 'true_false', value: false })).toEqual({
      kind: 'true_false',
      value: false,
    });
    expect(AttemptPayload.parse({ kind: 'fill_blank', blanks: ['', '光合作用'] })).toEqual({
      kind: 'fill_blank',
      blanks: ['', '光合作用'],
    });
    expect(AttemptPayload.parse({ kind: 'numeric', value: 9.8, unit: 'm/s^2' })).toEqual({
      kind: 'numeric',
      value: 9.8,
      unit: 'm/s^2',
    });
    expect(AttemptPayload.parse({ kind: 'numeric', value: 42 })).toEqual({
      kind: 'numeric',
      value: 42,
    });
    expect(AttemptPayload.parse({ kind: 'free_text', text: 'an essay' })).toEqual({
      kind: 'free_text',
      text: 'an essay',
    });
  });

  it('rejects a missing or foreign discriminant', () => {
    expect(AttemptPayload.safeParse({ selected: ['A'] }).success).toBe(false);
    expect(AttemptPayload.safeParse({ kind: 'mystery', value: 1 }).success).toBe(false);
  });

  it('rejects a payload whose body does not match its declared kind', () => {
    // choice without `selected`
    expect(AttemptPayload.safeParse({ kind: 'choice' }).success).toBe(false);
    // empty selection is "left blank", not a choice payload
    expect(AttemptPayload.safeParse({ kind: 'choice', selected: [] }).success).toBe(false);
    // true_false expects a boolean, not a string
    expect(AttemptPayload.safeParse({ kind: 'true_false', value: 'yes' }).success).toBe(false);
    // numeric expects a number
    expect(AttemptPayload.safeParse({ kind: 'numeric', value: '9.8' }).success).toBe(false);
    // fill_blank needs at least one blank
    expect(AttemptPayload.safeParse({ kind: 'fill_blank', blanks: [] }).success).toBe(false);
  });
});

describe('QuestionKind → archetype mapping', () => {
  it('structures the clean objective kinds and falls back to free_text otherwise', () => {
    expect(expectedAttemptPayloadKind('choice')).toBe('choice');
    expect(expectedAttemptPayloadKind('true_false')).toBe('true_false');
    expect(expectedAttemptPayloadKind('fill_blank')).toBe('fill_blank');
    // computation routes keyword|semantic by rubric → deferred to free_text
    // (owner open question #2). This test locks that deferral.
    expect(expectedAttemptPayloadKind('computation')).toBe('free_text');
    expect(expectedAttemptPayloadKind('derivation')).toBe('free_text');
    for (const kind of ['short_answer', 'essay', 'reading', 'translation'] as const) {
      expect(expectedAttemptPayloadKind(kind)).toBe('free_text');
    }
  });

  it('maps every QuestionKind (exhaustive — no kind silently unrouted)', () => {
    const valid: ReadonlySet<AttemptPayloadKindT> = new Set([
      'choice',
      'true_false',
      'fill_blank',
      'numeric',
      'free_text',
    ]);
    for (const kind of QuestionKind.options as readonly QuestionKindT[]) {
      const archetype = ATTEMPT_PAYLOAD_KIND_BY_QUESTION_KIND[kind];
      expect(archetype).toBeDefined();
      expect(valid.has(archetype)).toBe(true);
    }
  });
});

describe('parseAttemptPayloadForKind (错型 reject gate)', () => {
  it('accepts the matching objective payload for the question kind', () => {
    expect(parseAttemptPayloadForKind('choice', { kind: 'choice', selected: ['B'] })).toEqual({
      kind: 'choice',
      selected: ['B'],
    });
    expect(parseAttemptPayloadForKind('true_false', { kind: 'true_false', value: true })).toEqual({
      kind: 'true_false',
      value: true,
    });
    expect(parseAttemptPayloadForKind('fill_blank', { kind: 'fill_blank', blanks: ['x'] })).toEqual(
      {
        kind: 'fill_blank',
        blanks: ['x'],
      },
    );
  });

  it('rejects a payload of the wrong archetype for the question kind', () => {
    // a true_false payload submitted against a choice question
    expect(() =>
      parseAttemptPayloadForKind('choice', { kind: 'true_false', value: true }),
    ).toThrow();
    // a free_text payload against a true_false question
    expect(
      safeParseAttemptPayloadForKind('true_false', { kind: 'free_text', text: 'maybe' }).success,
    ).toBe(false);
  });

  it('passes open / prose kinds through free_text', () => {
    for (const kind of ['short_answer', 'essay', 'reading', 'translation', 'derivation'] as const) {
      expect(parseAttemptPayloadForKind(kind, { kind: 'free_text', text: 'response' })).toEqual({
        kind: 'free_text',
        text: 'response',
      });
    }
  });

  it('routes computation through free_text (deferred numeric structuring)', () => {
    expect(
      parseAttemptPayloadForKind('computation', { kind: 'free_text', text: '9.8 m/s^2' }),
    ).toEqual({
      kind: 'free_text',
      text: '9.8 m/s^2',
    });
    // a numeric payload is NOT (yet) accepted for computation — owner open question #2
    expect(
      safeParseAttemptPayloadForKind('computation', { kind: 'numeric', value: 9.8 }).success,
    ).toBe(false);
  });

  it('attemptPayloadSchemaForKind returns the single member schema', () => {
    expect(
      attemptPayloadSchemaForKind('choice').safeParse({ kind: 'choice', selected: ['A'] }).success,
    ).toBe(true);
    expect(
      attemptPayloadSchemaForKind('essay').safeParse({ kind: 'choice', selected: ['A'] }).success,
    ).toBe(false);
  });
});

describe('AttemptOnQuestion event payload back-compat (byte-identical anchor)', () => {
  const baseEvent = {
    actor_kind: 'user' as const,
    actor_ref: 'owner',
    action: 'attempt' as const,
    subject_kind: 'question' as const,
    subject_id: 'q-1',
    outcome: 'success' as const,
    payload: {
      answer_md: 'A',
      answer_image_refs: [] as string[],
      referenced_knowledge_ids: [] as string[],
    },
  };

  it('parses a historical attempt event WITHOUT attempt_payload unchanged', () => {
    const parsed = AttemptOnQuestion.parse(baseEvent);
    expect(parsed.payload.attempt_payload).toBeUndefined();
  });

  it('parses an attempt event WITH a valid structured attempt_payload', () => {
    const parsed = AttemptOnQuestion.parse({
      ...baseEvent,
      payload: { ...baseEvent.payload, attempt_payload: { kind: 'choice', selected: ['A'] } },
    });
    expect(parsed.payload.attempt_payload).toEqual({ kind: 'choice', selected: ['A'] });
  });

  it('rejects an attempt event carrying a malformed attempt_payload', () => {
    const res = AttemptOnQuestion.safeParse({
      ...baseEvent,
      payload: { ...baseEvent.payload, attempt_payload: { kind: 'choice' } },
    });
    expect(res.success).toBe(false);
  });
});

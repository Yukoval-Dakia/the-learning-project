// ADR-0038 决定#2 — deterministic plan gate unit tests (no DB; the live-KC read
// lives in the handler, this exercises the pure parse/pin/knowledge checks).

import { describe, expect, it } from 'vitest';
import {
  QUIZ_PLAN_MAX_ATTEMPTS,
  checkPlanKnowledgeIds,
  checkPlanPins,
  parsePlanOutput,
} from './quiz_gen_plan';

const VALID_PLAN_JSON = JSON.stringify({
  items: [
    { knowledge_id: 'k1', kind: 'short_answer', difficulty: 3 },
    { knowledge_id: 'k1', kind: 'choice', difficulty: 2, answer_anchor: '主谓间助词' },
  ],
  generation_method: 'search_grounded',
});

describe('parsePlanOutput (ADR-0038 plan artifact)', () => {
  it('accepts a valid plan and returns the typed artifact', () => {
    const result = parsePlanOutput(VALID_PLAN_JSON);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.items).toHaveLength(2);
      expect(result.plan.generation_method).toBe('search_grounded');
    }
  });

  it('rejects an objective-kind item missing its answer_anchor', () => {
    const result = parsePlanOutput(
      JSON.stringify({
        items: [{ knowledge_id: 'k1', kind: 'choice', difficulty: 2 }],
        generation_method: 'search_grounded',
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.join('\n')).toMatch(/choice.*requires an answer_anchor/);
    }
  });

  it('does NOT require an anchor for non-objective kinds (byte-parity: plans cover all kinds)', () => {
    const result = parsePlanOutput(
      JSON.stringify({
        items: [{ knowledge_id: 'k1', kind: 'translation', difficulty: 4 }],
        generation_method: 'closed_book',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object JSON / schema-invalid plan with reasons instead of throwing', () => {
    const result = parsePlanOutput('no json here');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons[0]).toMatch(/no JSON object found/);
  });
});

describe('checkPlanPins (kind / method sanity)', () => {
  it('rejects a plan item that violates a required kind pin', () => {
    const plan = parsePlanOutput(VALID_PLAN_JSON);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const reasons = checkPlanPins(plan.plan, { kind: 'reading', kindRequired: true });
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toMatch(
      /item 1 plans kind 'short_answer' which does not match required kind 'reading'/,
    );
  });

  it('rejects an objective-only pin violation', () => {
    const plan = parsePlanOutput(VALID_PLAN_JSON);
    if (!plan.ok) throw new Error('fixture must parse');
    const reasons = checkPlanPins(plan.plan, { kind: 'choice', objectiveOnly: true });
    expect(reasons.join('\n')).toMatch(/does not match objective-only kind 'choice'/);
  });

  it('accepts a cross-vocabulary pin via kindsMatch normalization (reading_comprehension ↔ reading)', () => {
    const plan = parsePlanOutput(
      JSON.stringify({
        items: [{ knowledge_id: 'k1', kind: 'reading', difficulty: 3 }],
        generation_method: 'search_grounded',
      }),
    );
    if (!plan.ok) throw new Error('fixture must parse');
    expect(checkPlanPins(plan.plan, { kind: 'reading_comprehension', kindRequired: true })).toEqual(
      [],
    );
  });

  it('rejects a plan whose generation_method violates the pinned method', () => {
    const plan = parsePlanOutput(VALID_PLAN_JSON);
    if (!plan.ok) throw new Error('fixture must parse');
    const reasons = checkPlanPins(plan.plan, { generationMethod: 'closed_book' });
    expect(reasons.join('\n')).toMatch(
      /plans generation_method 'search_grounded' but the run pins 'closed_book'/,
    );
  });

  it('passes an unpinned plan through untouched (free choice preserved)', () => {
    const plan = parsePlanOutput(VALID_PLAN_JSON);
    if (!plan.ok) throw new Error('fixture must parse');
    expect(checkPlanPins(plan.plan, {})).toEqual([]);
  });
});

describe('checkPlanKnowledgeIds (real knowledge-point existence)', () => {
  it('rejects an item targeting an unknown / archived node', () => {
    const plan = parsePlanOutput(VALID_PLAN_JSON);
    if (!plan.ok) throw new Error('fixture must parse');
    const reasons = checkPlanKnowledgeIds(plan.plan, new Set(['k1']));
    expect(reasons).toEqual([]);
    const ghost = checkPlanKnowledgeIds(plan.plan, new Set(['some-other-node']));
    expect(ghost.join('\n')).toMatch(/item 1 targets unknown or archived knowledge_id 'k1'/);
  });
});

describe('QUIZ_PLAN_MAX_ATTEMPTS', () => {
  it('bounds regeneration (initial attempt + one retry)', () => {
    expect(QUIZ_PLAN_MAX_ATTEMPTS).toBe(2);
  });
});

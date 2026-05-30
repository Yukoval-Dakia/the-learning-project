import { describe, expect, it } from 'vitest';

import {
  COACH_CONTEXT_BUDGET,
  COPILOT_CONTEXT_BUDGET,
  DREAMING_CONTEXT_BUDGET,
  KNOWLEDGE_EXCERPT_MAX,
  MISTAKE_PROMPT_SNIPPET_MAX,
  TOOL_COURTESY_DEFAULTS,
  resolveContextBudget,
} from './budgets';

// P5.1 / YUK-143 — budget-constant snapshot test (spec §7). Locks the numbers
// so any future tuning is a deliberate, reviewed change rather than an accident.
describe('context budgets — locked constants', () => {
  it('COPILOT_CONTEXT_BUDGET matches the spec CB-2 numbers', () => {
    expect(COPILOT_CONTEXT_BUDGET).toEqual({
      maxToolCalls: 10,
      maxNodesPlusEdges: 250,
      maxEventRows: 1000,
      maxExcerptChars: 180,
    });
  });

  // Byte-unchanged guard: these MUST equal the values Dreaming/Coach hardcoded
  // before P5.1 (max_tool_calls 8/12, max_proposals 5/5). If this ever changes,
  // Dreaming/Coach behavior changed — which the relocation refactor forbids.
  it('DREAMING_CONTEXT_BUDGET preserves the prior hardcoded caps (8 / 5)', () => {
    expect(DREAMING_CONTEXT_BUDGET.maxToolCalls).toBe(8);
    expect(DREAMING_CONTEXT_BUDGET.maxProposals).toBe(5);
    expect(DREAMING_CONTEXT_BUDGET.maxExcerptChars).toBe(180);
  });

  it('COACH_CONTEXT_BUDGET preserves the prior hardcoded caps (12 / 5)', () => {
    expect(COACH_CONTEXT_BUDGET.maxToolCalls).toBe(12);
    expect(COACH_CONTEXT_BUDGET.maxProposals).toBe(5);
    expect(COACH_CONTEXT_BUDGET.maxExcerptChars).toBe(180);
  });

  it('per-tool courtesy defaults equal the tools current defaults (no behavior change)', () => {
    expect(TOOL_COURTESY_DEFAULTS).toEqual({
      query_knowledge: 10,
      expand_knowledge_subgraph: 30,
      query_mistakes: 20,
      query_events: 20,
      get_attempt_context: 10,
    });
  });

  it('excerpt caps equal the prior file-local constants (180 / 160)', () => {
    expect(KNOWLEDGE_EXCERPT_MAX).toBe(180);
    expect(MISTAKE_PROMPT_SNIPPET_MAX).toBe(160);
  });

  it('resolveContextBudget routes each surface to its budget', () => {
    expect(resolveContextBudget('copilot')).toBe(COPILOT_CONTEXT_BUDGET);
    expect(resolveContextBudget('copilot_user_suggested_mistake_action')).toBe(
      COPILOT_CONTEXT_BUDGET,
    );
    expect(resolveContextBudget('dreaming')).toBe(DREAMING_CONTEXT_BUDGET);
    expect(resolveContextBudget('coach')).toBe(COACH_CONTEXT_BUDGET);
    // knowledge_review / maintenance fall back to a generous default budget.
    expect(resolveContextBudget('maintenance').maxToolCalls).toBeGreaterThan(0);
    expect(resolveContextBudget('knowledge_review').maxNodesPlusEdges).toBe(250);
  });
});

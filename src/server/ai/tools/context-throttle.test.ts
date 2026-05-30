import { describe, expect, it } from 'vitest';

import { COPILOT_CONTEXT_BUDGET, type ContextBudget } from './budgets';
import { ContextBudgetTracker } from './context-throttle';

// P5.1 / YUK-143 — Copilot per-message accumulator unit test (spec §7).
// Mirrors the dreaming/coach test style: drive the tracker's beforeExecute /
// capInput seams directly (no live DB / AI), assert the per-message budget is
// respected across multiple calls and that over-budget degrades GRACEFULLY
// (partial result + truncation flag), never a throw.

describe('ContextBudgetTracker — tool-call ceiling (soft-stop)', () => {
  it('allows up to maxToolCalls then returns a soft-stop string', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);
    for (let i = 0; i < COPILOT_CONTEXT_BUDGET.maxToolCalls; i += 1) {
      expect(tracker.beforeExecute({ name: 'query_knowledge', effect: 'read' })).toBeUndefined();
    }
    // The 11th call (budget is 10) is softly stopped — a string, not a throw.
    const stop = tracker.beforeExecute({ name: 'query_knowledge', effect: 'read' });
    expect(typeof stop).toBe('string');
    expect(stop).toMatch(/context budget reached/);
    expect(tracker.snapshot().toolCalls).toBe(COPILOT_CONTEXT_BUDGET.maxToolCalls);
  });

  it('counts every effect (read / propose / write) against the tool-call budget', () => {
    const budget: ContextBudget = { ...COPILOT_CONTEXT_BUDGET, maxToolCalls: 2 };
    const tracker = new ContextBudgetTracker(budget);
    expect(tracker.beforeExecute({ name: 'query_events', effect: 'read' })).toBeUndefined();
    expect(
      tracker.beforeExecute({ name: 'propose_knowledge_edge', effect: 'propose' }),
    ).toBeUndefined();
    expect(tracker.beforeExecute({ name: 'query_knowledge', effect: 'read' })).toMatch(
      /context budget reached/,
    );
  });
});

describe('ContextBudgetTracker — capInput limit capping (nodes+edges)', () => {
  it('applies the courtesy default when the caller omits the limit', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);
    const { args, truncation } = tracker.capInput('query_knowledge', { subjectId: 'wenyan' });
    // Default 10 fits well under 250 → no rewrite, no truncation note.
    expect((args as { limit?: number }).limit).toBeUndefined();
    expect(truncation).toBeNull();
    expect(tracker.snapshot().nodesPlusEdgesUsed).toBe(10);
  });

  it('passes an explicit in-budget limit through unchanged', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);
    const { args, truncation } = tracker.capInput('query_knowledge', {
      subjectId: 'wenyan',
      limit: 40,
    });
    expect((args as { limit: number }).limit).toBe(40);
    expect(truncation).toBeNull();
    expect(tracker.snapshot().nodesPlusEdgesUsed).toBe(40);
  });

  it('caps an over-budget request down to remaining budget and flags truncation', () => {
    // Tight budget so a single call exceeds it.
    const budget: ContextBudget = { ...COPILOT_CONTEXT_BUDGET, maxNodesPlusEdges: 25 };
    const tracker = new ContextBudgetTracker(budget);
    const { args, truncation } = tracker.capInput('expand_knowledge_subgraph', {
      centerNodeId: 'k_1',
      maxNodes: 60,
    });
    expect((args as { maxNodes: number }).maxNodes).toBe(25);
    expect(truncation).toEqual({
      applied_limit: 25,
      requested_limit: 60,
      budget_remaining: 0,
      truncated: true,
      dimension: 'nodesPlusEdges',
    });
  });

  it('sums nodes+edges across multiple calls in one message and truncates the tail', () => {
    const budget: ContextBudget = { ...COPILOT_CONTEXT_BUDGET, maxNodesPlusEdges: 50 };
    const tracker = new ContextBudgetTracker(budget);

    // 1st call: 40 fits (remaining 50 → uses 40, 10 left).
    const first = tracker.capInput('query_knowledge', { subjectId: 'wenyan', limit: 40 });
    expect((first.args as { limit: number }).limit).toBe(40);
    expect(first.truncation).toBeNull();

    // 2nd call: asks for 30 but only 10 remain → capped to 10 + truncation note.
    const second = tracker.capInput('query_knowledge', { subjectId: 'wenyan', limit: 30 });
    expect((second.args as { limit: number }).limit).toBe(10);
    expect(second.truncation).toMatchObject({
      applied_limit: 10,
      requested_limit: 30,
      truncated: true,
      dimension: 'nodesPlusEdges',
    });

    // 3rd call: nothing left → capped to 0, still graceful (no throw).
    const third = tracker.capInput('query_knowledge', { subjectId: 'wenyan', limit: 5 });
    expect((third.args as { limit: number }).limit).toBe(0);
    expect(third.truncation?.truncated).toBe(true);
    expect(tracker.snapshot().nodesPlusEdgesUsed).toBe(50);
  });
});

describe('ContextBudgetTracker — capInput limit capping (event rows)', () => {
  it('draws query_mistakes / query_events / get_attempt_context from the event-row budget', () => {
    const budget: ContextBudget = { ...COPILOT_CONTEXT_BUDGET, maxEventRows: 30 };
    const tracker = new ContextBudgetTracker(budget);

    // query_mistakes nested filter.limit.
    const m = tracker.capInput('query_mistakes', { filter: { limit: 20 } });
    expect((m.args as { filter: { limit: number } }).filter.limit).toBe(20);
    expect(m.truncation).toBeNull();

    // query_events nested filter.limit — only 10 left → capped.
    const e = tracker.capInput('query_events', { filter: { limit: 20 } });
    expect((e.args as { filter: { limit: number } }).filter.limit).toBe(10);
    expect(e.truncation?.dimension).toBe('eventRows');
    expect(e.truncation?.truncated).toBe(true);

    expect(tracker.snapshot().eventRowsUsed).toBe(30);
    // The nodes+edges dimension is untouched by event-row tools.
    expect(tracker.snapshot().nodesPlusEdgesUsed).toBe(0);
  });

  it('caps get_attempt_context.timelineLimit (top-level path) from the event-row budget', () => {
    const budget: ContextBudget = { ...COPILOT_CONTEXT_BUDGET, maxEventRows: 4 };
    const tracker = new ContextBudgetTracker(budget);
    const r = tracker.capInput('get_attempt_context', {
      attemptEventId: 'ev_1',
      timelineLimit: 50,
    });
    expect((r.args as { timelineLimit: number }).timelineLimit).toBe(4);
    expect(r.truncation?.truncated).toBe(true);
  });
});

describe('ContextBudgetTracker — unbounded tools pass through', () => {
  it('does not cap tools without a registered limit param', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);
    const args = { subjectId: 'wenyan' };
    const { args: out, truncation } = tracker.capInput('get_subject_graph_overview', args);
    expect(out).toBe(args);
    expect(truncation).toBeNull();
    // No accounting against either dimension.
    expect(tracker.snapshot()).toMatchObject({ nodesPlusEdgesUsed: 0, eventRowsUsed: 0 });
  });
});

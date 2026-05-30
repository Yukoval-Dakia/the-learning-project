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
    expect(second.softStop).toBeNull();
    expect(second.truncation).toMatchObject({
      applied_limit: 10,
      requested_limit: 30,
      truncated: true,
      dimension: 'nodesPlusEdges',
    });

    // 3rd call: nothing left → EXHAUSTED. FIX 1: graceful soft-stop, NOT a
    // limit:0 rewrite (which would trip the tool's Zod min and throw). No
    // truncation note, no further accounting, args untouched.
    const third = tracker.capInput('query_knowledge', { subjectId: 'wenyan', limit: 5 });
    expect(typeof third.softStop).toBe('string');
    expect(third.softStop).toMatch(/context budget exhausted \(nodesPlusEdges\)/);
    expect(third.truncation).toBeNull();
    // args are passed through unchanged — no limit:0 ever materialized.
    expect((third.args as { limit: number }).limit).toBe(5);
    // Budget stays at the cap (the exhausted call didn't account anything).
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

// FIX 1 (YUK-143) — the spec's central invariant: budget EXHAUSTION degrades
// to a graceful soft-stop, never a limit:0 arg (which would trip the tool's
// own Zod min and throw). This is the load-bearing regression guard.
describe('ContextBudgetTracker — exhaustion soft-stops (never limit:0)', () => {
  it('returns a soft-stop string (no limit:0 rewrite, no truncation note) when the dimension is exhausted', () => {
    // Budget large enough for one call, then exhausted.
    const budget: ContextBudget = { ...COPILOT_CONTEXT_BUDGET, maxEventRows: 20 };
    const tracker = new ContextBudgetTracker(budget);

    // 1st call consumes all 20 event rows.
    const first = tracker.capInput('query_mistakes', { filter: { limit: 20 } });
    expect(first.softStop).toBeNull();
    expect(first.truncation).toBeNull();
    expect(tracker.snapshot().eventRowsUsed).toBe(20);

    // 2nd call: 0 remaining → soft-stop, NOT a limit:0 arg.
    const second = tracker.capInput('query_events', { filter: { limit: 20 } });
    expect(typeof second.softStop).toBe('string');
    expect(second.softStop).toMatch(/context budget exhausted \(eventRows\)/);
    expect(second.softStop).toMatch(/stop calling read tools/);
    expect(second.truncation).toBeNull();
    // The original args are passed through verbatim — limit:0 is NEVER produced.
    expect((second.args as { filter: { limit: number } }).filter.limit).toBe(20);
    // No further accounting — the exhausted call ran nothing.
    expect(tracker.snapshot().eventRowsUsed).toBe(20);
  });

  it('partial budget caps to remaining (>= 1) and emits a truncation note — never 0', () => {
    // Leave exactly 1 row of headroom so the clamp must floor at 1, not 0.
    const budget: ContextBudget = { ...COPILOT_CONTEXT_BUDGET, maxEventRows: 21 };
    const tracker = new ContextBudgetTracker(budget);

    // Consume 20 of 21.
    tracker.capInput('query_mistakes', { filter: { limit: 20 } });
    expect(tracker.snapshot().eventRowsUsed).toBe(20);

    // Ask for 20 but only 1 remains → capped to 1 (>= 1), with a truncation note.
    const partial = tracker.capInput('query_events', { filter: { limit: 20 } });
    expect((partial.args as { filter: { limit: number } }).filter.limit).toBe(1);
    expect(partial.softStop).toBeNull();
    expect(partial.truncation).toMatchObject({
      applied_limit: 1,
      requested_limit: 20,
      truncated: true,
      dimension: 'eventRows',
    });
    expect(tracker.snapshot().eventRowsUsed).toBe(21);
  });
});

// FIX 2 (YUK-143) — the other bounded-row Copilot readers must draw down the
// SAME eventRows budget, so COPILOT_CONTEXT_BUDGET.maxEventRows is enforced
// across ALL Copilot row tools (spec §7), not just the original 5.
describe('ContextBudgetTracker — newly-budgeted Copilot readers count against eventRows', () => {
  it('charges query_records / get_review_due / get_question_context to the event-row budget', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);

    // query_records — top-level limit, courtesy default 20.
    const records = tracker.capInput('query_records', { kind: ['note'] });
    expect(records.softStop).toBeNull();
    expect(records.truncation).toBeNull();
    expect(tracker.snapshot().eventRowsUsed).toBe(20);

    // get_review_due — top-level limit, courtesy default 20.
    const due = tracker.capInput('get_review_due', {});
    expect(due.softStop).toBeNull();
    expect(tracker.snapshot().eventRowsUsed).toBe(40);

    // get_question_context — attemptLimit path, courtesy default 10.
    const q = tracker.capInput('get_question_context', { questionId: 'q_1' });
    expect(q.softStop).toBeNull();
    expect(tracker.snapshot().eventRowsUsed).toBe(50);

    // None of these touched the nodes+edges dimension.
    expect(tracker.snapshot().nodesPlusEdgesUsed).toBe(0);
  });

  it('caps an explicit over-remaining query_records request and flags truncation', () => {
    const budget: ContextBudget = { ...COPILOT_CONTEXT_BUDGET, maxEventRows: 15 };
    const tracker = new ContextBudgetTracker(budget);
    const r = tracker.capInput('query_records', { limit: 50 });
    expect((r.args as { limit: number }).limit).toBe(15);
    expect(r.truncation).toMatchObject({
      applied_limit: 15,
      requested_limit: 50,
      truncated: true,
      dimension: 'eventRows',
    });
  });
});

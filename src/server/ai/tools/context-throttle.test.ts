import { describe, expect, it } from 'vitest';

import { COPILOT_CONTEXT_BUDGET, type ContextBudget } from './budgets';
import { ContextBudgetTracker } from './context-throttle';

// P5.1 / YUK-143 — Copilot per-message accumulator unit test (spec §7).
// Mirrors the dreaming/coach test style: drive the tracker's beforeExecute /
// capInput seams directly (no live DB / AI), assert the per-message budget is
// respected across multiple calls and that over-budget degrades GRACEFULLY
// (partial result + truncation flag), never a throw.

describe('ContextBudgetTracker — two-tier tool-call budget', () => {
  it('rejects a warning threshold above its hard ceiling', () => {
    const budget: ContextBudget = {
      ...COPILOT_CONTEXT_BUDGET,
      eventRows: { warning: 31, hard: 30 },
    };

    expect(() => new ContextBudgetTracker(budget)).toThrow(
      'Invalid ContextBudget: eventRows warning (31) must be <= hard (30)',
    );
  });

  it('warns at the old watermark but only soft-stops at the hard ceiling', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);
    for (let i = 0; i < COPILOT_CONTEXT_BUDGET.toolCalls.hard; i += 1) {
      expect(tracker.beforeExecute({ name: 'query_knowledge', effect: 'read' })).toBeUndefined();
      const notice = tracker.currentNotice();
      if (i + 1 < COPILOT_CONTEXT_BUDGET.toolCalls.warning) expect(notice).toBeNull();
      else expect(notice?.dimensions.toolCalls?.used).toBe(i + 1);
    }
    // The 26th call is softly stopped; calls 11–25 remain available to heavy questions.
    const stop = tracker.beforeExecute({ name: 'query_knowledge', effect: 'read' });
    expect(typeof stop).toBe('string');
    expect(stop).toMatch(/hard context budget reached/);
    expect(tracker.snapshot().toolCalls).toBe(COPILOT_CONTEXT_BUDGET.toolCalls.hard);
  });

  it('counts every effect (read / propose / write) against the tool-call budget', () => {
    const budget: ContextBudget = {
      ...COPILOT_CONTEXT_BUDGET,
      toolCalls: { warning: 1, hard: 2 },
    };
    const tracker = new ContextBudgetTracker(budget);
    expect(tracker.beforeExecute({ name: 'query_events', effect: 'read' })).toBeUndefined();
    expect(
      tracker.beforeExecute({ name: 'propose_knowledge_edge', effect: 'propose' }),
    ).toBeUndefined();
    expect(tracker.beforeExecute({ name: 'query_knowledge', effect: 'read' })).toMatch(
      /hard context budget reached/,
    );
  });
});

describe('ContextBudgetTracker — capInput limit capping (nodes+edges)', () => {
  it('applies the courtesy default when the caller omits the limit', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);
    const { args, contextBudget } = tracker.capInput('query_knowledge', {
      subjectId: 'yuwen',
    });
    // Default 10 fits well under 250 → no rewrite, no truncation note.
    expect((args as { limit?: number }).limit).toBeUndefined();
    expect(contextBudget).toBeNull();
    expect(tracker.snapshot().nodesPlusEdgesUsed).toBe(10);
  });

  it('passes an explicit in-budget limit through unchanged', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);
    const { args, contextBudget } = tracker.capInput('query_knowledge', {
      subjectId: 'yuwen',
      limit: 40,
    });
    expect((args as { limit: number }).limit).toBe(40);
    expect(contextBudget).toBeNull();
    expect(tracker.snapshot().nodesPlusEdgesUsed).toBe(40);
  });

  it('crosses warning without rewriting args and surfaces remaining hard headroom', () => {
    const budget: ContextBudget = {
      ...COPILOT_CONTEXT_BUDGET,
      nodesPlusEdges: { warning: 25, hard: 100 },
    };
    const tracker = new ContextBudgetTracker(budget);
    const { args, contextBudget } = tracker.capInput('expand_knowledge_subgraph', {
      centerNodeId: 'k_1',
      maxNodes: 60,
    });
    expect((args as { maxNodes: number }).maxNodes).toBe(60);
    expect(contextBudget).toEqual({
      level: 'warning',
      dimensions: {
        nodesPlusEdges: {
          used: 60,
          warning_limit: 25,
          hard_limit: 100,
          hard_remaining: 40,
        },
      },
      truncated: false,
    });
  });

  it('sums across calls, warns without capping, then truncates only at hard', () => {
    const budget: ContextBudget = {
      ...COPILOT_CONTEXT_BUDGET,
      nodesPlusEdges: { warning: 50, hard: 100 },
    };
    const tracker = new ContextBudgetTracker(budget);

    // 1st call: below warning.
    const first = tracker.capInput('query_knowledge', { subjectId: 'yuwen', limit: 40 });
    expect((first.args as { limit: number }).limit).toBe(40);
    expect(first.contextBudget).toBeNull();

    // 2nd call crosses warning but runs all 30.
    const second = tracker.capInput('query_knowledge', { subjectId: 'yuwen', limit: 30 });
    expect((second.args as { limit: number }).limit).toBe(30);
    expect(second.softStop).toBeNull();
    expect(second.contextBudget).toMatchObject({ level: 'warning', truncated: false });

    // 3rd call asks for 50 with 30 hard headroom → capped at 30.
    const third = tracker.capInput('query_knowledge', { subjectId: 'yuwen', limit: 50 });
    expect((third.args as { limit: number }).limit).toBe(30);
    expect(third.contextBudget).toMatchObject({
      level: 'hard',
      applied_limit: 30,
      requested_limit: 50,
      truncated: true,
      dimension: 'nodesPlusEdges',
    });
    expect(tracker.snapshot().nodesPlusEdgesUsed).toBe(100);

    const fourth = tracker.capInput('query_knowledge', { subjectId: 'yuwen', limit: 5 });
    expect(fourth.softStop).toMatch(/hard context budget exhausted \(nodesPlusEdges/);
    expect((fourth.args as { limit: number }).limit).toBe(5);
  });
});

describe('ContextBudgetTracker — capInput limit capping (event rows)', () => {
  it('draws query_mistakes / query_events / get_attempt_context from the event-row budget', () => {
    const budget: ContextBudget = {
      ...COPILOT_CONTEXT_BUDGET,
      eventRows: { warning: 10, hard: 30 },
    };
    const tracker = new ContextBudgetTracker(budget);

    // query_mistakes nested filter.limit.
    const m = tracker.capInput('query_mistakes', { filter: { limit: 20 } });
    expect((m.args as { filter: { limit: number } }).filter.limit).toBe(20);
    expect(m.contextBudget).toMatchObject({ level: 'warning', truncated: false });

    // query_events nested filter.limit — only 10 left → capped.
    const e = tracker.capInput('query_events', { filter: { limit: 20 } });
    expect((e.args as { filter: { limit: number } }).filter.limit).toBe(10);
    expect(e.contextBudget?.dimension).toBe('eventRows');
    expect(e.contextBudget?.truncated).toBe(true);

    expect(tracker.snapshot().eventRowsUsed).toBe(30);
    // The nodes+edges dimension is untouched by event-row tools.
    expect(tracker.snapshot().nodesPlusEdgesUsed).toBe(0);
  });

  it('caps get_attempt_context.timelineLimit (top-level path) from the event-row budget', () => {
    const budget: ContextBudget = {
      ...COPILOT_CONTEXT_BUDGET,
      eventRows: { warning: 2, hard: 4 },
    };
    const tracker = new ContextBudgetTracker(budget);
    const r = tracker.capInput('get_attempt_context', {
      attemptEventId: 'ev_1',
      timelineLimit: 50,
    });
    expect((r.args as { timelineLimit: number }).timelineLimit).toBe(4);
    expect(r.contextBudget?.truncated).toBe(true);
  });
});

describe('ContextBudgetTracker — unbounded tools pass through', () => {
  it('does not cap tools without a registered limit param', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);
    const args = { subjectId: 'yuwen' };
    const { args: out, contextBudget } = tracker.capInput('get_subject_graph_overview', args);
    expect(out).toBe(args);
    expect(contextBudget).toBeNull();
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
    const budget: ContextBudget = {
      ...COPILOT_CONTEXT_BUDGET,
      eventRows: { warning: 10, hard: 20 },
    };
    const tracker = new ContextBudgetTracker(budget);

    // 1st call consumes all 20 event rows.
    const first = tracker.capInput('query_mistakes', { filter: { limit: 20 } });
    expect(first.softStop).toBeNull();
    expect(first.contextBudget).toMatchObject({ level: 'hard', truncated: false });
    expect(tracker.snapshot().eventRowsUsed).toBe(20);

    // 2nd call: 0 remaining → soft-stop, NOT a limit:0 arg.
    const second = tracker.capInput('query_events', { filter: { limit: 20 } });
    expect(typeof second.softStop).toBe('string');
    expect(second.softStop).toMatch(/hard context budget exhausted \(eventRows/);
    expect(second.softStop).toMatch(/stop calling read tools/);
    expect(second.contextBudget).toMatchObject({ level: 'hard', truncated: false });
    // The original args are passed through verbatim — limit:0 is NEVER produced.
    expect((second.args as { filter: { limit: number } }).filter.limit).toBe(20);
    // No further accounting — the exhausted call ran nothing.
    expect(tracker.snapshot().eventRowsUsed).toBe(20);
  });

  it('partial budget caps to remaining (>= 1) and emits a truncation note — never 0', () => {
    // Leave exactly 1 row of headroom so the clamp must floor at 1, not 0.
    const budget: ContextBudget = {
      ...COPILOT_CONTEXT_BUDGET,
      eventRows: { warning: 10, hard: 21 },
    };
    const tracker = new ContextBudgetTracker(budget);

    // Consume 20 of 21.
    tracker.capInput('query_mistakes', { filter: { limit: 20 } });
    expect(tracker.snapshot().eventRowsUsed).toBe(20);

    // Ask for 20 but only 1 remains → capped to 1 (>= 1), with a truncation note.
    const partial = tracker.capInput('query_events', { filter: { limit: 20 } });
    expect((partial.args as { filter: { limit: number } }).filter.limit).toBe(1);
    expect(partial.softStop).toBeNull();
    expect(partial.contextBudget).toMatchObject({
      applied_limit: 1,
      requested_limit: 20,
      truncated: true,
      dimension: 'eventRows',
    });
    expect(tracker.snapshot().eventRowsUsed).toBe(21);
  });
});

// FIX 2 (YUK-143) — the other bounded-row Copilot readers must draw down the
// SAME eventRows budget, so COPILOT_CONTEXT_BUDGET.eventRows is enforced
// across ALL Copilot row tools (spec §7), not just the original 5.
describe('ContextBudgetTracker — newly-budgeted Copilot readers count against eventRows', () => {
  it('charges query_records / get_review_due / get_question_context to the event-row budget', () => {
    const tracker = new ContextBudgetTracker(COPILOT_CONTEXT_BUDGET);

    // query_records — top-level limit, courtesy default 20.
    const records = tracker.capInput('query_records', { kind: ['note'] });
    expect(records.softStop).toBeNull();
    expect(records.contextBudget).toBeNull();
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
    const budget: ContextBudget = {
      ...COPILOT_CONTEXT_BUDGET,
      eventRows: { warning: 5, hard: 15 },
    };
    const tracker = new ContextBudgetTracker(budget);
    const r = tracker.capInput('query_records', { limit: 50 });
    expect((r.args as { limit: number }).limit).toBe(15);
    expect(r.contextBudget).toMatchObject({
      applied_limit: 15,
      requested_limit: 50,
      truncated: true,
      dimension: 'eventRows',
    });
  });
});

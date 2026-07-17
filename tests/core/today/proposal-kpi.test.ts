import { aiProposalKinds } from '@/core/schema/proposal';
import { summarizeTodayProposalKpi } from '@/server/today/proposal-kpi';
import { describe, expect, it } from 'vitest';

describe('summarizeTodayProposalKpi', () => {
  it('returns zero counts for every proposal kind when inbox is empty', () => {
    const summary = summarizeTodayProposalKpi({});

    expect(summary.total).toBe(0);
    expect(summary.has_more).toBe(false);
    expect(summary.status).toBe('pending');
    for (const kind of aiProposalKinds) {
      expect(summary.by_kind[kind]).toBe(0);
    }
  });

  it('counts pending proposal aggregates by AiProposalKind', () => {
    const summary = summarizeTodayProposalKpi({
      knowledge_node: 1,
      knowledge_edge: 2,
      note_update: 1,
      variant_question: 1,
    });

    expect(summary.total).toBe(5);
    expect(summary.by_kind.knowledge_node).toBe(1);
    expect(summary.by_kind.knowledge_edge).toBe(2);
    expect(summary.by_kind.note_update).toBe(1);
    expect(summary.by_kind.variant_question).toBe(1);
    expect(summary.by_kind.learning_item).toBe(0);
  });

  it('keeps observe-only facts while excluding them from learner decisions', () => {
    const summary = summarizeTodayProposalKpi({
      defer: 500,
      archive: 1,
      knowledge_edge: 1,
      completion: 1,
    });

    expect(summary.total).toBe(503);
    expect(summary.decision_total).toBe(2);
    expect(summary.has_more).toBe(false);
    expect(summary.limit).toBe(500);
    expect(summary.by_kind.defer).toBe(500);
    expect(summary.by_kind.archive).toBe(1);
    expect(summary.by_kind.knowledge_edge).toBe(1);
    expect(summary.by_kind.completion).toBe(1);
  });
});

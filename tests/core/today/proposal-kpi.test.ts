import { type AiProposalKindT, aiProposalKinds } from '@/core/schema/proposal';
import { summarizeTodayProposalKpi } from '@/server/today/proposal-kpi';
import { describe, expect, it } from 'vitest';

function row(kind: AiProposalKindT) {
  return { kind };
}

describe('summarizeTodayProposalKpi', () => {
  it('returns zero counts for every proposal kind when inbox is empty', () => {
    const summary = summarizeTodayProposalKpi([]);

    expect(summary.total).toBe(0);
    expect(summary.has_more).toBe(false);
    expect(summary.status).toBe('pending');
    for (const kind of aiProposalKinds) {
      expect(summary.by_kind[kind]).toBe(0);
    }
  });

  it('counts pending proposal rows by AiProposalKind', () => {
    const summary = summarizeTodayProposalKpi([
      row('knowledge_node'),
      row('knowledge_edge'),
      row('knowledge_edge'),
      row('note_update'),
      row('variant_question'),
    ]);

    expect(summary.total).toBe(5);
    expect(summary.by_kind.knowledge_node).toBe(1);
    expect(summary.by_kind.knowledge_edge).toBe(2);
    expect(summary.by_kind.note_update).toBe(1);
    expect(summary.by_kind.variant_question).toBe(1);
    expect(summary.by_kind.learning_item).toBe(0);
  });

  it('preserves capped pagination metadata from the inbox reader', () => {
    const summary = summarizeTodayProposalKpi([row('completion')], {
      hasMore: true,
      limit: 1,
    });

    expect(summary.total).toBe(1);
    expect(summary.has_more).toBe(true);
    expect(summary.limit).toBe(1);
  });
});

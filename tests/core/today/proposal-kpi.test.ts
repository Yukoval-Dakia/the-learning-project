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

  it('reports has_more=false at the cap when no overflow row exists (exactly 500)', () => {
    const rows = Array.from({ length: 500 }, () => row('knowledge_node'));
    const summary = summarizeTodayProposalKpi(rows, { hasMore: false, limit: 500 });

    expect(summary.total).toBe(500);
    expect(summary.has_more).toBe(false);
    expect(summary.by_kind.knowledge_node).toBe(500);
  });

  it('reports has_more=true at the cap when overflow row exists (501+ pending)', () => {
    // listProposalInboxPage reads limit+1 rows internally and reports has_more
    // separately from the capped row list. summarize should pass that through
    // without inflating `total` past the cap.
    const rows = Array.from({ length: 500 }, () => row('knowledge_edge'));
    const summary = summarizeTodayProposalKpi(rows, { hasMore: true, limit: 500 });

    expect(summary.total).toBe(500);
    expect(summary.has_more).toBe(true);
    expect(summary.by_kind.knowledge_edge).toBe(500);
  });
});

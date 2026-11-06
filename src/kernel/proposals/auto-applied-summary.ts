// Learner-facing one-liner for an auto-applied proposal card.
//
// The anchor snapshots this text at apply time, so the card never re-derives from
// the proposal's technical reason_md (metrics, ids, field names). Anchors written
// before `summary_source` existed are untrusted on the read side and get the
// same per-kind sentence instead of their historical reason text.

import type { AiProposalPayloadT } from '@/core/schema/proposal';
import { learnerSummaryIfAllowed } from './learner-summary';
import { proposalReasonPlainText } from './reason-text';

export type AutoAppliedSummarySource = 'learner_summary' | 'generated';

export interface AutoAppliedSummary {
  summary: string;
  source: AutoAppliedSummarySource;
}

/** Fixed Chinese line per auto-apply kind; never contains ids, tools or metrics. */
export function autoAppliedKindFallback(kind: string): string {
  switch (kind) {
    case 'knowledge_node':
      return '新增了一个知识点，已经放进你的知识树';
    case 'cause_category':
      return '新增了一个错因分类，方便以后的复盘归类';
    case 'learning_item':
      return '为你整理了一条学习路径';
    case 'completion':
      return '自动判定为完成并已记录';
    default:
      return '自动应用了一条改动';
  }
}

function learningItemTopic(payload: AiProposalPayloadT): string | null {
  if (payload.kind !== 'learning_item') return null;
  const topic = payload.proposed_change.topic;
  if (typeof topic !== 'string') return null;
  const text = topic.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/** A validated learner_summary wins; otherwise the per-kind line replaces reason_md. */
export function resolveAutoAppliedSummary(payload: AiProposalPayloadT): AutoAppliedSummary {
  if (payload.learner_summary !== undefined) {
    return {
      summary: proposalReasonPlainText(payload.learner_summary),
      source: 'learner_summary',
    };
  }
  const topic = learningItemTopic(payload);
  const topicLine =
    topic === null ? undefined : learnerSummaryIfAllowed(`为你把「${topic}」整理成一条学习路径`);
  return {
    summary: proposalReasonPlainText(topicLine ?? autoAppliedKindFallback(payload.kind)),
    source: 'generated',
  };
}

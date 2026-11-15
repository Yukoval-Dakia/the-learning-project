import { z } from 'zod';
import { parseAiProposalPayload } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import {
  completionReceiptDisplayAllowed,
  completionReceiptSummary,
  parseCompletionReceipt,
} from './completion-receipt';
import type { LegacyKnowledgeProposalRow, ProposalInboxRow } from './inbox';
import { mapProposalReasonFields, proposalReasonPlainText } from './reason-text';

export function proposalInboxRowForLearner(row: ProposalInboxRow): ProposalInboxRow {
  return {
    ...row,
    payload: parseAiProposalPayload(mapProposalReasonFields(row.payload)),
  };
}

export function legacyKnowledgeProposalForLearner(
  row: LegacyKnowledgeProposalRow,
): LegacyKnowledgeProposalRow {
  return {
    ...row,
    reasoning: proposalReasonPlainText(row.reasoning),
    payload: z.record(z.string(), z.unknown()).parse(mapProposalReasonFields(row.payload)),
  };
}

/** Run before presentation for every status and both single/batch reads. Raw receipts never leave the owner. */
export async function projectCompletionForLearner(
  db: Db | Tx,
  row: ProposalInboxRow,
): Promise<void> {
  if (row.payload.kind !== 'completion') return;
  const subjectKind = row.target.subject_kind === 'goal' ? 'goal' : 'learning_item';
  const goalTitle =
    typeof row.payload.proposed_change.goal_title === 'string'
      ? row.payload.proposed_change.goal_title
      : '';
  const parsed = parseCompletionReceipt(row.payload.proposed_change.receipt);
  const allowed =
    parsed !== null &&
    (row.target.subject_kind === 'goal' || row.target.subject_kind === 'learning_item') &&
    parsed.item_id === row.target.subject_id &&
    row.payload.proposed_change[subjectKind === 'goal' ? 'goal_id' : 'learning_item_id'] ===
      parsed.item_id &&
    (await completionReceiptDisplayAllowed(db, parsed, subjectKind));
  const summary = allowed
    ? completionReceiptSummary(parsed, subjectKind === 'goal' ? goalTitle : undefined)
    : '这条完成建议的依据暂不可用；可以忽略它。';
  row.payload = parseAiProposalPayload({
    ...row.payload,
    reason_md: summary,
    learner_summary: summary,
    evidence_refs: [],
    proposed_change: {
      ...(subjectKind === 'goal'
        ? { goal_id: row.target.subject_id, ...(allowed ? { goal_title: goalTitle } : {}) }
        : { learning_item_id: row.target.subject_id }),
      ...(allowed
        ? {
            completion_summary: {
              observed_at: parsed.measured_at,
              knowledge_count: parsed.knowledge.length,
              minimum_mastery: Math.min(...parsed.knowledge.map((k) => k.point)),
              minimum_evidence: Math.min(
                ...parsed.knowledge.map((k) => k.evidence.filter((e) => e.correct).length),
              ),
            },
          }
        : {}),
    },
    rollback_plan: {
      action: subjectKind === 'goal' ? '撤回后恢复原目标状态' : '撤回后恢复原学习计划状态',
    },
  });
  if (!allowed) {
    row.not_acceptable_reason = 'completion_evidence_unavailable';
    row.batch_confirm_eligible = false;
  }
}

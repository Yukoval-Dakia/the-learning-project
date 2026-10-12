import { z } from 'zod';
import { parseAiProposalPayload } from '@/core/schema/proposal';
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

/**
 * The FULL evidence contract must be able to name every DomainTool call that a
 * durable Copilot run can execute. Keep the validator schema and durable
 * anti-runaway ceiling on this shared value.
 */
export const COPILOT_EVIDENCE_MAX_TRACE_CALLS = 60;

export const COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME = 'evidence_submission';

export const COPILOT_EVIDENCE_SUBMISSION_TOOLS = {
  appendEvidencePoints: 'append_evidence_points',
  markTraceCallsNotMaterial: 'mark_trace_calls_not_material',
  setSafeReply: 'set_safe_reply',
  completeReference: 'complete_reference',
  appendReplyChecks: 'append_reply_checks',
  completeComparison: 'complete_comparison',
} as const;

function evidenceSubmissionToolName(localName: string): string {
  return `mcp__${COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME}__${localName}`;
}

export const COPILOT_EVIDENCE_REFERENCE_ALLOWED_TOOLS = [
  evidenceSubmissionToolName(COPILOT_EVIDENCE_SUBMISSION_TOOLS.appendEvidencePoints),
  evidenceSubmissionToolName(COPILOT_EVIDENCE_SUBMISSION_TOOLS.markTraceCallsNotMaterial),
  evidenceSubmissionToolName(COPILOT_EVIDENCE_SUBMISSION_TOOLS.setSafeReply),
  evidenceSubmissionToolName(COPILOT_EVIDENCE_SUBMISSION_TOOLS.completeReference),
] as const;

export const COPILOT_EVIDENCE_COMPARISON_ALLOWED_TOOLS = [
  evidenceSubmissionToolName(COPILOT_EVIDENCE_SUBMISSION_TOOLS.appendReplyChecks),
  evidenceSubmissionToolName(COPILOT_EVIDENCE_SUBMISSION_TOOLS.completeComparison),
] as const;

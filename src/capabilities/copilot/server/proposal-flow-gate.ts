import type { ToolExecutionGateInput, ToolExecutionResultObservation } from '@/kernel/tools/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A ZodError message is the JSON-serialized issues array. Detect that shape so
// typed/input validation failures — whether thrown by the bridge's outer parse
// (executed=false) or by a tool's own in-execute schema parse — are NOT treated
// as executed proposal failures. Bad-args failures need arg repair, not a
// forced re-read.
function isZodIssuesError(reason: string): boolean {
  const trimmed = reason.trimStart();
  if (!trimmed.startsWith('[')) return false;
  try {
    const issues: unknown = JSON.parse(trimmed);
    return (
      Array.isArray(issues) &&
      issues.length > 0 &&
      issues.every(
        (issue) => isRecord(issue) && typeof issue.code === 'string' && Array.isArray(issue.path),
      )
    );
  } catch {
    return false;
  }
}

function requiresReplan(result: ToolExecutionResultObservation): boolean {
  if (result.effect !== 'propose') return false;
  // The call never reached the tool's execute (input parse rejection, a gate
  // block, or a budget soft-stop). The tree is untouched — nothing to
  // re-plan around.
  if (!result.executed) return false;
  if (result.error_reason !== null) return !isZodIssuesError(result.error_reason);
  if (!isRecord(result.output)) return false;
  const status = result.output.status;
  // skipped:invalid_payload is in-execute input validation (same failure class
  // as a Zod issues error): the tree is untouched, so arg repair + retry is the
  // right loop — not a forced re-read. All other skipped:* statuses are genuine
  // world-state rejections (duplicate/cross-subject/rubric/…) that keep the
  // replan contract.
  if (status === 'skipped:invalid_payload') return false;
  return typeof status === 'string' && (status === 'failed' || status.startsWith('skipped:'));
}

export function createCopilotProposalFlowGate(): {
  beforeExecute: (tool: ToolExecutionGateInput) => string | undefined;
  observe: (result: ToolExecutionResultObservation) => void;
} {
  let replanRequired = false;
  return {
    beforeExecute(tool) {
      return replanRequired && tool.effect !== 'read'
        ? 'proposal_requires_replan_after_typed_failure'
        : undefined;
    },
    observe(result) {
      if (requiresReplan(result)) {
        replanRequired = true;
      } else if (result.effect === 'read' && result.error_reason === null) {
        replanRequired = false;
      }
    },
  };
}

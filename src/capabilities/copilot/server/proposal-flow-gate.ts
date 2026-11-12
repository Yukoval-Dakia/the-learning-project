import { isDeepStrictEqual } from 'node:util';
import type { ToolExecutionGateInput, ToolExecutionResultObservation } from '@/kernel/tools/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A ZodError message is the JSON-serialized issues array. Detect that shape so
// input validation failures — thrown by the bridge's outer parse or by a tool's
// own in-execute parse — are NOT treated as executed proposal failures; they
// need arg repair, not a forced re-read.
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
  // block, or a budget soft-stop), so the tree is untouched.
  if (!result.executed) return false;
  if (result.error_reason !== null) return !isZodIssuesError(result.error_reason);
  if (!isRecord(result.output)) return false;
  const status = result.output.status;
  // skipped:invalid_payload is in-execute input validation (same class as a
  // Zod issues error): the tree is untouched. skipped:duplicate_pending means
  // the identical proposal is already inbox-pending and skipped:already_exists
  // means a live object already satisfies the intent (the output carries its
  // id) — both CONFIRM the world state the plan assumed, so no re-read is owed
  // and downstream writes may proceed. All other skipped:* statuses are
  // genuine world-state rejections (cross-subject/rubric/cooldown/not-found/…)
  // that keep the replan contract.
  if (
    status === 'skipped:invalid_payload' ||
    status === 'skipped:duplicate_pending' ||
    status === 'skipped:already_exists'
  ) {
    return false;
  }
  return typeof status === 'string' && (status === 'failed' || status.startsWith('skipped:'));
}

function failureDetail(result: ToolExecutionResultObservation): string {
  if (result.error_reason !== null) return result.error_reason;
  const output = isRecord(result.output) ? result.output : {};
  const issues = Array.isArray(output.issues)
    ? output.issues.flatMap((issue) =>
        isRecord(issue) && typeof issue.detail === 'string' ? [issue.detail] : [],
      )
    : [];
  const summary = [output.reasoning_summary, output.reason].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return [String(output.status), ...(issues.length > 0 ? issues : summary ? [summary] : [])].join(
    ': ',
  );
}

/**
 * After a proposal fails on world state, only the identical call is refused: a changed draft
 * is the repair the failure asked for. A successful read clears the memory, as before.
 */
export function createCopilotProposalFlowGate(): {
  refuseIdentical: (tool: ToolExecutionGateInput, args: unknown) => string | undefined;
  observe: (result: ToolExecutionResultObservation) => void;
} {
  let failed: { name: string; input: unknown; detail: string } | null = null;
  return {
    refuseIdentical(tool, args) {
      return failed &&
        tool.effect !== 'read' &&
        tool.name === failed.name &&
        isDeepStrictEqual(args, failed.input)
        ? `proposal_requires_replan_after_typed_failure: 这次调用和上次失败的完全相同，上次失败原因：${failed.detail}。按原因改动后再提交。`
        : undefined;
    },
    observe(result) {
      if (requiresReplan(result)) {
        failed = { name: result.name, input: result.input, detail: failureDetail(result) };
      } else if (result.effect === 'read' && result.error_reason === null) {
        failed = null;
      }
    },
  };
}

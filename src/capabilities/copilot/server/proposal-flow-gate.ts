import type { ToolExecutionGateInput, ToolExecutionResultObservation } from '@/kernel/tools/types';

const REPLAN_REQUIRED_STATUSES = new Set([
  'skipped:not_found',
  'skipped:unknown_node',
  'skipped:invalid_payload',
  'failed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiresReplan(result: ToolExecutionResultObservation): boolean {
  if (result.effect !== 'propose') return false;
  if (result.error_reason !== null) return true;
  if (!isRecord(result.output)) return false;
  const status = result.output.status;
  return typeof status === 'string' && REPLAN_REQUIRED_STATUSES.has(status);
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

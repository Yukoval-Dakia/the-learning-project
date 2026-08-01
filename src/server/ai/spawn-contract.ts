import type {
  AgentDefinition,
  CanUseTool,
  HookCallback,
  Options,
} from '@anthropic-ai/claude-agent-sdk';

/** Runtime tool name used by the Agent SDK to start a nested agent. */
export const SPAWN_TOOL_NAME = 'Task';

/**
 * YUK-572/YUK-757 v2 deliberately observes real spend before choosing a number.
 * This mode never denies an enabled spawn because of an attempt count.
 */
export const SPAWN_BUDGET_MODE = 'report_only' as const;

export type SpawnBudgetDecision =
  | 'allow'
  | 'deny_kill_switch'
  | 'deny_unknown_agent'
  | 'deny_input_override';

export interface SpawnBudgetObservation {
  mode: typeof SPAWN_BUDGET_MODE;
  /** Shared correlation id exposed by both PreToolUse and canUseTool. */
  toolUseId: string;
  /** One-based position among distinct Task calls in this run. */
  ordinal: number;
  decision: SpawnBudgetDecision;
}

export interface SpawnBudgetReport {
  mode: typeof SPAWN_BUDGET_MODE;
  observedAttempts: number;
  allowedAttempts: number;
  deniedByKillSwitch: number;
  deniedByContract: number;
  /** In first-observed order; useful for correlation with existing tool-call logs. */
  toolUseIds: string[];
}

export interface CreateSpawnContractOptions {
  /** Required caller-owned kill switch state. No implicit environment lookup. */
  enabled: boolean;
  /** Definitions are cloned and reduced to depth=1; caller input is not mutated. */
  agents: Record<string, AgentDefinition>;
  disabledReason?: string;
  /**
   * Best-effort report-only sink. It fires once per distinct Task toolUseID, even when
   * both SDK guard surfaces consult the same call.
   */
  onBudgetObservation?: (observation: SpawnBudgetObservation) => void;
}

export interface SpawnContract {
  /** Depth-one definitions: nested agents cannot invoke Task again. */
  agents: Record<string, AgentDefinition>;
  hooks: NonNullable<Options['hooks']>;
  canUseTool: CanUseTool;
  readBudgetReport(): SpawnBudgetReport;
}

const DEFAULT_DISABLED_REASON = 'subagent spawn kill switch is disabled';

function makeDepthOneAgent(definition: AgentDefinition): AgentDefinition {
  const tools = definition.tools?.filter((toolName) => toolName !== SPAWN_TOOL_NAME);
  const disallowedTools = [...new Set([...(definition.disallowedTools ?? []), SPAWN_TOOL_NAME])];
  return {
    ...definition,
    ...(definition.tools === undefined ? {} : { tools }),
    disallowedTools,
  };
}

function makeDepthOneAgents(
  agents: Record<string, AgentDefinition>,
): Record<string, AgentDefinition> {
  return Object.fromEntries(
    Object.entries(agents).map(([name, definition]) => [name, makeDepthOneAgent(definition)]),
  );
}

/**
 * Shared v2 nested-agent contract.
 *
 * Two SDK surfaces can inspect one Task call. Decisions are memoized by their common
 * toolUseID, so callback order and duplicate consultations cannot double-count or
 * disagree. The explicit kill switch and declared-agent/depth boundary can deny; the
 * budget path itself is intentionally report-only until production observations
 * justify a numeric policy.
 */
export function createSpawnContract(options: CreateSpawnContractOptions): SpawnContract {
  const decisions = new Map<string, { decision: SpawnBudgetDecision; message?: string }>();
  const disabledReason = options.disabledReason ?? DEFAULT_DISABLED_REASON;
  const allowedAgentNames = new Set(Object.keys(options.agents));

  function decide(
    toolUseId: string,
    input: unknown,
  ): { decision: SpawnBudgetDecision; message?: string } {
    const previous = decisions.get(toolUseId);
    if (previous !== undefined) return previous;

    let record: { decision: SpawnBudgetDecision; message?: string };
    if (!options.enabled) {
      record = { decision: 'deny_kill_switch', message: disabledReason };
    } else {
      const taskInput =
        input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const subagentType = taskInput.subagent_type;
      if (typeof subagentType !== 'string' || !allowedAgentNames.has(subagentType)) {
        record = {
          decision: 'deny_unknown_agent',
          message: `unknown subagent_type; allowed: ${[...allowedAgentNames].join(', ') || '(none)'}`,
        };
      } else if (
        'model' in taskInput ||
        'isolation' in taskInput ||
        taskInput.run_in_background === true
      ) {
        // Role definitions, not model-emitted Task input, own model/isolation and
        // foreground completion. A background override can let the parent finish
        // without receiving the child conclusion, breaking one-voice product flow.
        // Reject rather than silently strip so both guard surfaces make the same
        // correlation-id keyed decision and the attempted privilege change is visible.
        record = {
          decision: 'deny_input_override',
          message: 'Task model/isolation/background overrides are not allowed',
        };
      } else {
        record = { decision: 'allow' };
      }
    }
    decisions.set(toolUseId, record);
    try {
      options.onBudgetObservation?.({
        mode: SPAWN_BUDGET_MODE,
        toolUseId,
        ordinal: decisions.size,
        decision: record.decision,
      });
    } catch (error) {
      // Observability must not become a third permission layer. Existing SDK tool-call
      // and cost logging still owns authoritative execution/cost evidence.
      console.warn('[spawn-contract] budget observer failed (report-only)', {
        tool_use_id: toolUseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return record;
  }

  const preToolUseHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== SPAWN_TOOL_NAME) {
      return { continue: true };
    }
    const decision = decide(input.tool_use_id, input.tool_input);
    if (decision.decision === 'allow') return { continue: true };
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.message,
      },
    };
  };

  const canUseTool: CanUseTool = async (toolName, input, permissionOptions) => {
    if (toolName !== SPAWN_TOOL_NAME) return { behavior: 'allow' };
    const decision = decide(permissionOptions.toolUseID, input);
    if (decision.decision === 'allow') return { behavior: 'allow' };
    return { behavior: 'deny', message: decision.message ?? 'spawn denied by contract' };
  };

  return {
    agents: makeDepthOneAgents(options.agents),
    hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] },
    canUseTool,
    readBudgetReport() {
      const entries = [...decisions.entries()];
      return {
        mode: SPAWN_BUDGET_MODE,
        observedAttempts: entries.length,
        allowedAttempts: entries.filter(([, record]) => record.decision === 'allow').length,
        deniedByKillSwitch: entries.filter(([, record]) => record.decision === 'deny_kill_switch')
          .length,
        deniedByContract: entries.filter(
          ([, record]) =>
            record.decision === 'deny_unknown_agent' || record.decision === 'deny_input_override',
        ).length,
        toolUseIds: entries.map(([toolUseId]) => toolUseId),
      };
    },
  };
}

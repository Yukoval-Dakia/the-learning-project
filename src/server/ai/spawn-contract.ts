import type {
  AgentDefinition,
  CanUseTool,
  HookCallback,
  Options,
} from '@anthropic-ai/claude-agent-sdk';

/** Compatibility name accepted by the SDK for starting a nested agent. */
export const SPAWN_TOOL_NAME = 'Task';
/** The SDK emits `Agent`; `Task` remains a canonicalized compatibility alias. */
export const SPAWN_TOOL_ALIASES = ['Agent', SPAWN_TOOL_NAME] as const;
export const SPAWN_DISABLE_BACKGROUND_TASKS_ENV = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';

const SPAWN_TOOL_NAME_SET = new Set<string>(SPAWN_TOOL_ALIASES);

export function isSpawnToolName(toolName: string): boolean {
  return SPAWN_TOOL_NAME_SET.has(toolName);
}

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
  const tools = definition.tools?.filter((toolName) => !isSpawnToolName(toolName));
  const disallowedTools = [
    ...new Set([...(definition.disallowedTools ?? []), ...SPAWN_TOOL_ALIASES]),
  ];
  return {
    ...definition,
    ...(definition.tools === undefined ? {} : { tools }),
    disallowedTools,
    // Every contract-managed spawn returns into its parent before that parent
    // can complete. The runner uses this explicit value to scope the SDK flag
    // without changing generic callers that intentionally define background agents.
    background: false,
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
        'name' in taskInput ||
        taskInput.run_in_background === true
      ) {
        // Role definitions, not model-emitted Task input, own model/isolation and
        // foreground completion. A background override can let the parent finish
        // without receiving the child conclusion, breaking one-voice product flow.
        // Reject rather than silently strip so both guard surfaces make the same
        // correlation-id keyed decision and the attempted privilege change is visible.
        record = {
          decision: 'deny_input_override',
          message: 'Agent model/isolation/name/background overrides are not allowed',
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

  function forceForegroundInput(input: unknown): Record<string, unknown> {
    return {
      ...(input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}),
      run_in_background: false,
    };
  }

  const preToolUseHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || !isSpawnToolName(input.tool_name)) {
      return { continue: true };
    }
    const decision = decide(input.tool_use_id, input.tool_input);
    if (decision.decision === 'allow') {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: forceForegroundInput(input.tool_input),
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.message,
      },
    };
  };

  const canUseTool: CanUseTool = async (toolName, input, permissionOptions) => {
    if (!isSpawnToolName(toolName)) return { behavior: 'allow' };
    const decision = decide(permissionOptions.toolUseID, input);
    if (decision.decision === 'allow') {
      return { behavior: 'allow', updatedInput: forceForegroundInput(input) };
    }
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

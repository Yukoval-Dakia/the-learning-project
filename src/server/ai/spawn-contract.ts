import type { AgentDefinition } from './sdk-types';

/** The wire name of the pi-mounted spawn tool. */
export const SPAWN_TOOL_NAME = 'Task';
/** `Agent` remains a canonicalized compatibility alias for `Task`. */
export const SPAWN_TOOL_ALIASES = ['Agent', SPAWN_TOOL_NAME] as const;

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
  /** Correlation id exposed by the beforeToolCall gate (the loop toolCall.id). */
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
   * Best-effort report-only sink. It fires once per distinct Task toolUseID.
   */
  onBudgetObservation?: (observation: SpawnBudgetObservation) => void;
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
    // can complete.
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
 * Depth-one reduction applied by the shared contract — strips spawn tools from
 * `tools`, adds them to `disallowedTools`, pins `background:false`. The pi
 * subagent host consumes the reduced definitions when it builds the
 * Task/Agent AgentTool.
 */
export function toDepthOneAgents(
  agents: Record<string, AgentDefinition>,
): Record<string, AgentDefinition> {
  return makeDepthOneAgents(agents);
}

/**
 * The engine-neutral half of the spawn contract (YUK-1022): memoized
 * per-toolUseId decisions plus the report-only budget ledger. The pi
 * beforeToolCall gate consults this decider so duplicate consultations cannot
 * double-count or disagree.
 */
export interface SpawnDecider {
  decide(toolUseId: string, input: unknown): { decision: SpawnBudgetDecision; message?: string };
  readBudgetReport(): SpawnBudgetReport;
}

export function createSpawnDecider(options: CreateSpawnContractOptions): SpawnDecider {
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
      // Observability must not become a third permission layer. The tool-call
      // and cost logging still owns authoritative execution/cost evidence.
      console.warn('[spawn-contract] budget observer failed (report-only)', {
        tool_use_id: toolUseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return record;
  }

  return {
    decide,
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

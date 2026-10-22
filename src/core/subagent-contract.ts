// Pure nested-agent declarations, depth-one reduction and spawn permission contract.
// Callers own their role prompts, tool allowlists and operational switches. The
// factory owns the memoized decider, spec projection and authoritative gate;
// model catalog validation, nested execution, abort lineage and paid evidence
// remain with the runtime. Permission observations are not an execution/cost ledger.

import type { PiBeforeToolCall } from './tool-call-contract';

/** Depth-reduced nested-agent spec — the caller-declared subagent definition. */
export interface AgentDefinition {
  description: string;
  prompt: string;
  /** Wire-name allowlist (`mcp__<server>__<tool>` or local tool names). */
  tools?: string[];
  disallowedTools?: string[];
  /** Pi catalog model id or 'inherit'; SDK alias names fail closed. */
  model?: string;
  /** Per-child assistant-turn ceiling. */
  maxTurns?: number;
  /** Kept for declared-surface parity — pi runs children synchronously. */
  background?: boolean;
}

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

/**
 * Depth-one reduction applied by the shared contract — strips spawn tools from
 * `tools`, adds them to `disallowedTools`, pins `background:false`. The pi
 * subagent host consumes the reduced definitions when it builds the
 * Task/Agent AgentTool.
 */
function toDepthOneAgents(
  agents: Record<string, AgentDefinition>,
): Record<string, AgentDefinition> {
  return Object.fromEntries(
    Object.entries(agents).map(([name, definition]) => [name, makeDepthOneAgent(definition)]),
  );
}

/**
 * The engine-neutral half of the spawn contract (YUK-1022): memoized
 * per-toolUseId decisions plus the report-only permission observations. The pi
 * beforeToolCall gate consults this decider so duplicate consultations cannot
 * double-count or disagree.
 */
export interface SpawnDecider {
  decide(toolUseId: string, input: unknown): { decision: SpawnBudgetDecision; message?: string };
  readBudgetReport(): SpawnBudgetReport;
}

function createSpawnDecider(options: CreateSpawnContractOptions): SpawnDecider {
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

/**
 * Engine-neutral nested-agent spec — the subset of AgentDefinition the pi
 * lane can serve. `tools`/`disallowedTools` carry the same wire names
 * (`mcp__<server>__<tool>` or local names) the SDK def declares; the adapter
 * filters its mounted AgentTools by them.
 */
export interface PiSubagentSpec {
  description: string;
  prompt: string;
  /** Allowlist of parent-mounted wire names; omitted ⇒ inherit the full set. */
  tools?: readonly string[];
  /** Additional exclusions applied on top of the allowlist. */
  disallowedTools?: readonly string[];
  /** Per-child assistant-turn ceiling (def.maxTurns); unbounded when absent. */
  maxTurns?: number;
  /**
   * Pi catalog model id or 'inherit'/undefined ⇒ parent model. SDK alias names
   * ('sonnet', 'opus', …) have no pi meaning — declaring one fails closed.
   */
  model?: string;
}

/** Reduce one AgentDefinition to the pi spec (model alias rejection lives
 *  in the adapter, which owns the catalog). */
function toPiSubagentSpec(definition: AgentDefinition): PiSubagentSpec {
  return {
    description: definition.description,
    prompt: definition.prompt,
    ...(definition.tools !== undefined ? { tools: definition.tools } : {}),
    ...(definition.disallowedTools !== undefined
      ? { disallowedTools: definition.disallowedTools }
      : {}),
    ...(typeof definition.maxTurns === 'number' ? { maxTurns: definition.maxTurns } : {}),
    ...(typeof definition.model === 'string' ? { model: definition.model } : {}),
  };
}

/** Apply the shared depth-one reduction then map to pi specs. */
function toPiSubagentSpecs(
  agents: Record<string, AgentDefinition>,
): Record<string, PiSubagentSpec> {
  return Object.fromEntries(
    Object.entries(toDepthOneAgents(agents)).map(([name, def]) => [name, toPiSubagentSpec(def)]),
  );
}

/**
 * The pi spawn contract: the shared memoized decider exposed as a
 * PiHookBridge beforeToolCall entry, plus the depth-one specs the adapter
 * turns into the Task/Agent tool. `readBudgetReport` surfaces the decider's
 * permission observations for the caller's spawn evidence.
 */
export interface PiSpawnContract {
  /** Depth-one specs for the adapter's Task/Agent tool (mount via piAgents). */
  piAgents: Record<string, PiSubagentSpec>;
  /** Gate entry for `piHooks.beforeToolCall` — the spawn permission surface. */
  gate: PiBeforeToolCall;
  readBudgetReport(): SpawnBudgetReport;
  /** Memoized permission decisions shared with the gate. */
  decider: SpawnDecider;
}

export function createPiSpawnContract(options: CreateSpawnContractOptions): PiSpawnContract {
  const decider = createSpawnDecider(options);
  const gate: PiBeforeToolCall = async (call, args) => {
    if (!isSpawnToolName(call.name)) return undefined;
    const decision = decider.decide(call.id, args);
    if (decision.decision === 'allow') {
      // A defined non-blocking result, not undefined: once the shared decider
      // answers 'allow' the gate is authoritative — no later chain entry may
      // rewrite the call. The pi loop itself treats `block:false` exactly like
      // an absent result.
      return { block: false };
    }
    // Deny = error tool result (retryable, memoized) — never a hard stop.
    return { block: true, reason: decision.message ?? 'spawn denied by contract' };
  };
  return {
    piAgents: toPiSubagentSpecs(options.agents),
    gate,
    readBudgetReport: () => decider.readBudgetReport(),
    decider,
  };
}

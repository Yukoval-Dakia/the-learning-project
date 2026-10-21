// YUK-921 P3 (YUK-1022) — pi nested-subagent surface, built on the shared
// spawn-contract (`createSpawnDecider`):
//
//   - `toPiSubagentSpecs`     — depth-one AgentDefinitions → engine-neutral specs.
//   - `createPiSpawnContract` — the shared decider as a beforeToolCall gate; deny
//     is an error tool result, never a hard stop.
//   - `buildPiSpawnAgentTools` — Task/Agent tools that hand off to the adapter's
//     `PiSubagentHost` (it owns the nested loop, abort lineage and task_* frames).
//
// Depth-one is structural: spawn tools mount only on the parent loop.

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiBeforeToolCall } from '../pi-hooks';
import type { AgentDefinition } from '../sdk-types';
import {
  type CreateSpawnContractOptions,
  SPAWN_TOOL_ALIASES,
  type SpawnBudgetReport,
  type SpawnDecider,
  createSpawnDecider,
  isSpawnToolName,
  toDepthOneAgents,
} from '../spawn-contract';

/**
 * Engine-neutral nested-agent spec: the subset of AgentDefinition the pi lane can
 * serve. Tool names are the same wire names the parent mounts.
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
   * Pi catalog model id, or 'inherit'/undefined for the parent model. SDK alias
   * names have no pi meaning — declaring one fails closed.
   */
  model?: string;
}

/** Reduce one AgentDefinition to the pi spec (alias rejection lives in the adapter). */
export function toPiSubagentSpec(definition: AgentDefinition): PiSubagentSpec {
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
export function toPiSubagentSpecs(
  agents: Record<string, AgentDefinition>,
): Record<string, PiSubagentSpec> {
  return Object.fromEntries(
    Object.entries(toDepthOneAgents(agents)).map(([name, def]) => [name, toPiSubagentSpec(def)]),
  );
}

/**
 * The pi spawn contract: the shared decider as a beforeToolCall entry plus the
 * depth-one specs the adapter turns into Task/Agent tools.
 */
export interface PiSpawnContract {
  /** Depth-one specs for the adapter's Task/Agent tool (mount via piAgents). */
  piAgents: Record<string, PiSubagentSpec>;
  /** Gate entry for `piHooks.beforeToolCall` — the spawn permission surface. */
  gate: PiBeforeToolCall;
  /** Observation ledger for the caller's spawn evidence. */
  readBudgetReport(): SpawnBudgetReport;
  /** Direct decider access (tests drive decide() without the hook wrapper). */
  decider: SpawnDecider;
}

export function createPiSpawnContract(
  options: CreateSpawnContractOptions,
  decider: SpawnDecider = createSpawnDecider(options),
): PiSpawnContract {
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

/**
 * Adapter-supplied nested-run host: the adapter owns the agentLoop, model, abort
 * lineage and task_* frame sink; the tool stays a thin serializer.
 */
export interface PiSubagentHost {
  /**
   * Run one nested agentLoop and return the child's final text (the tool result).
   * Must emit task_started/task_updated frames and throw on failure.
   */
  runNested(input: {
    toolCallId: string;
    subagentType: string;
    description: string;
    prompt: string;
    spec: PiSubagentSpec;
    signal: AbortSignal | undefined;
  }): Promise<string>;
}

const TASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    subagent_type: { type: 'string', description: 'Declared subagent to run.' },
    description: { type: 'string', description: 'Short task label for the activity stream.' },
    prompt: { type: 'string', description: 'Complete instructions for the subagent.' },
    run_in_background: {
      type: 'boolean',
      description: 'Unsupported on this lane — the contract denies true.',
    },
  },
  required: ['subagent_type', 'description', 'prompt'],
  additionalProperties: false,
} as const;

/**
 * Build the Task + Agent AgentTools. The description lists declared subagents so the
 * model sees the same affordance the SDK `agents` option provided.
 */
export function buildPiSpawnAgentTools(
  specs: Record<string, PiSubagentSpec>,
  host: PiSubagentHost,
): AgentTool[] {
  const roster = Object.entries(specs)
    .map(([name, spec]) => `- ${name}: ${spec.description}`)
    .join('\n');
  const description = `Run a declared subagent synchronously and return its final report.\n\nAvailable subagents:\n${roster}`;
  const execute: AgentTool['execute'] = async (toolCallId, params, signal) => {
    const input = (params ?? {}) as Record<string, unknown>;
    const subagentType = input.subagent_type;
    const spec = typeof subagentType === 'string' ? specs[subagentType] : undefined;
    if (!spec) {
      // The gate denies unknown types first; this guards direct/unfiltered mounts.
      throw new Error(
        `unknown subagent_type; allowed: ${Object.keys(specs).join(', ') || '(none)'}`,
      );
    }
    const text = await host.runNested({
      toolCallId,
      subagentType: subagentType as string,
      description: typeof input.description === 'string' ? input.description : '',
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      spec,
      signal,
    });
    return {
      content: [{ type: 'text' as const, text }],
      details: null,
    } satisfies AgentToolResult<null>;
  };
  return SPAWN_TOOL_ALIASES.map(
    (name): AgentTool => ({
      name,
      label: name,
      description,
      parameters: TASK_INPUT_SCHEMA as unknown as AgentTool['parameters'],
      execute,
    }),
  );
}

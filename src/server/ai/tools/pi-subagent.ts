// Runtime Task/Agent tool executor. Pure declarations, depth-one specs and the
// shared memoized permission gate belong to core/subagent-contract. This file
// mounts those specs and delegates execution to the adapter-owned host, which
// owns the nested agentLoop, abort lineage, task_* frames and usage settlement.
// Spawn tools are mounted only on the parent loop, never on a child.

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type PiSubagentSpec, SPAWN_TOOL_ALIASES } from '@/core/subagent-contract';

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

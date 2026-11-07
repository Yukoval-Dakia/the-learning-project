// Mounted pi tool surface + tool-call evidence (YUK-1677 slice of YUK-921/YUK-1547).
//
// One owner for the wrap every AgentTool gets before pi sees it: the bridge wire
// schema swap, the parameter-contract repair recorded ahead of validation, and
// the execute/attempt observation that feeds run evidence. Root and nested loops
// share this instance, so a child's turn_start cannot erase a parent's evidence.

import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';
import { rawArgumentsEvidence } from '@/core/raw-arguments-evidence';
import type { RunnerMessage } from './execution-adapter';
import { startTraceSpan, traceOperation } from './laminar-tracing';
import {
  sanitizeArgumentsEvidence,
  sanitizeArgumentsEvidenceText,
} from './provider-error-evidence';
import { createRunMonitor } from './run-monitor';
import {
  type ToolParamCoercion,
  isToolArgumentContractFailure,
  repairToolArguments,
} from './tool-param-contract';

export interface PiToolSurfaceInput {
  tools: readonly AgentTool[];
  sessionId: string;
  runId: string;
  /** The request's resolved credential, already scoped to non-oauth-file auth. */
  secrets: readonly string[];
  emitFrame: (frame: RunnerMessage) => void;
}

const TOOL_ARGS_PROGRESS_PREFIX_CHARS = 2048;

export class PiToolSurface {
  readonly tools: AgentTool[];
  private readonly bridgeWireParameters = new Map<string, AgentTool['parameters']>();
  private readonly executedToolCalls = new Map<string, number>();
  /**
   * YUK-1547/YUK-1559 (C1/C6) — `pendingCoercions` queues adopted string→JSON
   * repairs per tool (prepareArguments runs before validation, so a call that
   * never reaches execute still lands its `coerced` evidence); `pendingArgs`
   * holds original arguments captured at tool_execution_start for contract
   * rejection evidence.
   */
  private readonly pendingCoercions = new Map<string, ToolParamCoercion[][]>();
  private readonly pendingArgs = new Map<string, { toolName: string; args: unknown }>();
  /** Latest adopted repair per tool — the structured-submit terminal hands the
   *  capability what validation actually accepted. */
  private readonly repairedToolArgs = new Map<string, unknown>();
  private readonly runMonitor = createRunMonitor();

  constructor(private readonly input: PiToolSurfaceInput) {
    this.tools = input.tools.map((tool) => {
      const bridgeValidates = 'inputValidation' in tool && tool.inputValidation === 'bridge';
      if (bridgeValidates) this.bridgeWireParameters.set(tool.name, tool.parameters);
      // The bridge owns this input's complete validation. The provider still receives its canonical schema.
      const parameters = bridgeValidates
        ? ({ type: 'object', additionalProperties: true } as AgentTool['parameters'])
        : tool.parameters;
      return {
        ...tool,
        parameters,
        // YUK-1547/YUK-1559 (C1) — every mounted tool gets the parameter-contract
        // repair ahead of pi's validateToolArguments (prepareArguments is the only
        // seam that runs first). Unrepaired inputs go to their validation owner;
        // neither pi nor the bridge reaches domain execution with invalid input.
        prepareArguments: (rawArgs: unknown) => {
          const prepared = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
          const repaired = repairToolArguments(
            tool.parameters,
            prepared,
            bridgeValidates ? 'bridge' : 'pi',
          );
          if (repaired.coercions.length > 0) {
            this.repairedToolArgs.set(tool.name, repaired.args);
            const queue = this.pendingCoercions.get(tool.name) ?? [];
            queue.push(repaired.coercions);
            this.pendingCoercions.set(tool.name, queue);
          }
          return repaired.args;
        },
        execute: (...args: Parameters<AgentTool['execute']>) => {
          this.executedToolCalls.set(args[0], (this.executedToolCalls.get(args[0]) ?? 0) + 1);
          // Root and nested loops share these wrappers. Observe only actual
          // execute crossings, with the prepared arguments passed to the delegate.
          const observation = this.runMonitor.observeExecutedTool({
            toolName: tool.name,
            callId: args[0],
            args: args[1],
          });
          return traceOperation(
            'tool.execute',
            {
              task_run_id: this.input.runId,
              tool_name: tool.name,
              tool_call_id: args[0],
              executed: true,
              ...observation,
            },
            () => tool.execute(...args),
            {
              signal: args[2],
              outcome: (result) => (result.isError ? 'error' : 'success'),
              transcript: { input: () => args[1], output: (result) => result },
            },
          );
        },
      };
    });
  }

  /** The wire schema the bridge substitutes after validating itself. */
  wireParameters(): ReadonlyMap<string, AgentTool['parameters']> {
    return this.bridgeWireParameters;
  }

  /** Latest adopted repair for one tool, if any. */
  repairedArguments(toolName: string): unknown {
    return this.repairedToolArgs.get(toolName);
  }

  clearRepairedArguments(toolName: string): void {
    this.repairedToolArgs.delete(toolName);
  }

  /**
   * Per-loop streamed-arguments tracker: `rawByIndex` accumulates this turn's
   * deltas, `byCallId` binds them at message_end. Each loop owns its own pair so
   * a child's turn_start cannot erase a parent's evidence.
   */
  trackStreamedArgs(
    event: AgentEvent,
    rawByIndex: Map<number, string>,
    byCallId: Map<string, string>,
  ): void {
    if (event.type === 'turn_start') {
      rawByIndex.clear();
      byCallId.clear();
      return;
    }
    if (
      event.type === 'message_update' &&
      event.message.role === 'assistant' &&
      event.assistantMessageEvent.type === 'toolcall_delta'
    ) {
      const delta = event.assistantMessageEvent;
      rawByIndex.set(delta.contentIndex, (rawByIndex.get(delta.contentIndex) ?? '') + delta.delta);
      return;
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      event.message.content.forEach((block, index) => {
        if (block.type !== 'toolCall') return;
        const raw = rawByIndex.get(index);
        if (raw !== undefined) byCallId.set(block.id, raw);
      });
    }
  }

  /**
   * YUK-1548 §5 — emit bounded tool-args progress while arguments stream.
   * Only the tool identity, cumulative bytes and a short prefix leave the
   * loop; partial payloads (SVG/HTML source) never do. toolcall_start's
   * partial assistant message usually already carries id + name.
   */
  observeToolArgsProgress(event: AgentEvent, rawByIndex: Map<number, string>): void {
    if (
      event.type !== 'message_update' ||
      event.message.role !== 'assistant' ||
      event.assistantMessageEvent.type !== 'toolcall_delta'
    ) {
      return;
    }
    const { contentIndex, partial } = event.assistantMessageEvent;
    const block = partial.content[contentIndex];
    if (block?.type !== 'toolCall' || block.name.length === 0) return;
    const raw = rawByIndex.get(contentIndex);
    if (raw === undefined) return;
    this.input.emitFrame({
      source: 'pi',
      type: 'system',
      subtype: 'tool_args_progress',
      tool_name: block.name,
      tool_call_id: block.id,
      received_bytes: raw.length,
      args_prefix: raw.slice(0, TOOL_ARGS_PROGRESS_PREFIX_CHARS),
      uuid: randomUUID(),
      session_id: this.input.sessionId,
    });
  }

  observeToolAttempt(
    event: AgentEvent,
    streamedArgsByCallId: ReadonlyMap<string, string>,
    aborted: boolean,
  ): void {
    if (event.type === 'tool_execution_start') {
      // Capture original arguments BEFORE prepareArguments repair and validation
      // normalization — the C6 evidence baseline.
      this.pendingArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      return;
    }
    if (event.type !== 'tool_execution_end') return;
    const executions = this.executedToolCalls.get(event.toolCallId) ?? 0;
    if (executions > 0) {
      if (executions === 1) this.executedToolCalls.delete(event.toolCallId);
      else this.executedToolCalls.set(event.toolCallId, executions - 1);
    }
    const pending = this.pendingArgs.get(event.toolCallId);
    this.pendingArgs.delete(event.toolCallId);
    // Drain adopted repairs for this call: the `coerced` event carries
    // tool/field metadata only, never the payload.
    const coercedFields = this.pendingCoercions.get(event.toolName)?.shift();
    if (coercedFields && this.pendingCoercions.get(event.toolName)?.length === 0) {
      this.pendingCoercions.delete(event.toolName);
    }
    if (coercedFields && coercedFields.length > 0) {
      this.input.emitFrame({
        source: 'pi',
        type: 'system',
        subtype: 'tool_args_coerced',
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        fields: coercedFields,
        uuid: randomUUID(),
        session_id: this.input.sessionId,
      });
    }
    if (executions > 0) return;
    // YUK-1559 (C6) — a call rejected at the argument-contract seam never reached
    // execute: persist the sanitized ≤4KiB original arguments as run evidence.
    if (
      pending !== undefined &&
      isToolArgumentContractFailure({ isError: event.isError, content: event.result?.content })
    ) {
      // Fidelity: prefer this call's exact streamed bytes (sanitized — the
      // recursive pass redacts credentials inside embedded JSON fields). When no
      // deltas arrived, event.args is a pi-parsed object → label 'reconstructed'.
      const streamed = streamedArgsByCallId.get(event.toolCallId);
      const args_source = streamed !== undefined ? 'streamed' : 'reconstructed';
      const sanitizedText =
        streamed !== undefined
          ? sanitizeArgumentsEvidenceText(streamed, { secrets: this.input.secrets })
          : JSON.stringify(
              sanitizeArgumentsEvidence(pending.args ?? null, { secrets: this.input.secrets }),
            );
      this.input.emitFrame({
        source: 'pi',
        type: 'system',
        subtype: 'tool_args_contract_failed',
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        args_source,
        ...rawArgumentsEvidence(sanitizedText),
        uuid: randomUUID(),
        session_id: this.input.sessionId,
      });
    }
    // Pi emits start/end even for validation, missing-tool and hook-blocked calls.
    // None crossed AgentTool.execute; do not label them executed or copy errors/args.
    const span = startTraceSpan('tool.attempt', {
      task_run_id: this.input.runId,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      executed: false,
    });
    span.transcript('input', () => ({
      arguments: '[omitted: arguments unavailable on terminal event]',
    }));
    span.transcript('output', () => event.result);
    span.end(aborted ? 'cancelled' : event.isError ? 'error' : 'success');
  }
}

import type { AgentLoopConfig, AgentTool, FinishTurn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createNoProgressLoop } from '@/ai/no-progress-loop';
import type { PiHookBridge, PiToolCallObservation } from '@/core/tool-call-contract';
import { startTraceSpan } from './laminar-tracing';
import { emitPiAfterToolCall } from './pi-hooks';
import { assistantText } from './pi-runner-frames';

/** Owns one loop's progress state, including pi's pre-validation immediate results. */
export function installLoopProgress(
  config: AgentLoopConfig,
  tools: readonly AgentTool[],
  hooks: PiHookBridge | undefined,
  scope: { agentType?: string; loopId: string },
): { closure(): { readonly reason: string } | undefined } {
  const progress =
    scope.agentType === undefined && hooks?.progress ? hooks.progress : createNoProgressLoop();
  const before = config.beforeToolCall;
  const after = config.afterToolCall;
  const finish = config.finishTurn;
  let closureRecorded = false;
  const gated = new Set<string>();
  const observed = new Set<string>();
  const callFor = (id: string, name: string) => ({ id, name, ...scope });
  const effectFor = (name: string): PiToolCallObservation['effect'] =>
    (
      tools.find((tool) => tool.name === name) as
        | (AgentTool & {
            effect?: PiToolCallObservation['effect'];
          })
        | undefined
    )?.effect;

  config.beforeToolCall = async (context, signal) => {
    gated.add(context.toolCall.id);
    const verdict = await progress.beforeToolCall(
      callFor(context.toolCall.id, context.toolCall.name),
      context.args as Record<string, unknown>,
      signal,
    );
    return verdict ?? before?.(context, signal);
  };
  config.afterToolCall = async (context, signal) => {
    observed.add(context.toolCall.id);
    const override = await after?.(context, signal);
    const verdict = await progress.afterToolCall(
      {
        call: callFor(context.toolCall.id, context.toolCall.name),
        args: context.args as Record<string, unknown>,
        effect: effectFor(context.toolCall.name),
        isError: context.isError,
        output: context.result.content,
        ...(context.isError ? { error: context.result.content } : {}),
        interrupted: signal?.aborted,
      },
      signal,
    );
    return { ...override, ...verdict };
  };
  config.finishTurn = async (turn, signal) => {
    let terminate = false;
    const denials = new Map<string, string>();
    for (const result of turn.toolResults) {
      const wasGated = gated.delete(result.toolCallId);
      if (!observed.delete(result.toolCallId)) {
        const toolCall = turn.message.content.find(
          (block) => block.type === 'toolCall' && block.id === result.toolCallId,
        );
        if (toolCall?.type !== 'toolCall') continue;
        const call = callFor(result.toolCallId, result.toolName);
        if (!wasGated) {
          const denial = await progress.beforeToolCall(call, toolCall.arguments, signal);
          if (denial?.block) {
            denials.set(
              result.toolCallId,
              denial.reason ?? 'No progress; answer from collected evidence.',
            );
            terminate ||= denial.terminate === true;
          }
        }
        const observation: PiToolCallObservation = {
          call,
          args: toolCall.arguments,
          effect: effectFor(result.toolName),
          isError: result.isError,
          output: result.content,
          ...(result.isError ? { error: result.content } : {}),
          interrupted: signal?.aborted,
        };
        const override = await emitPiAfterToolCall(hooks, observation, signal);
        const verdict = await progress.afterToolCall(observation, signal);
        if (override?.content) result.content = override.content;
        if (override?.isError !== undefined) result.isError = override.isError;
        terminate ||= override?.terminate === true || verdict?.terminate === true;
      }
    }
    // Preserve structured-submit, correction, cost and caller-owned terminal policies.
    const closure = progress.closure?.();
    if (closure && !closureRecorded) {
      closureRecorded = true;
      startTraceSpan('loop.progress', { loop_id: scope.loopId, end_reason: closure.reason }).end(
        'success',
      );
    }
    const decision = await finish?.(turn, signal);
    // Keep native/contract errors intact for the owner's correction protocol.
    for (const result of turn.toolResults) {
      const denial = denials.get(result.toolCallId);
      if (denial) result.content = [...result.content, { type: 'text', text: denial }];
    }
    return terminate ? { action: 'end' } : (decision ?? undefined);
  };
  return { closure: () => progress.closure?.() };
}

/** A terminated tool turn is not a completed child report, even if it has a preamble. */
export function completedChildReport(
  final: AssistantMessage,
  progress: ReturnType<typeof installLoopProgress>,
  agentType: string,
): string {
  const text = assistantText(final);
  if (!text.trim() || final.content.some((block) => block.type === 'toolCall')) {
    throw new Error(
      `nested subagent '${agentType}' stopped without a final text report (${progress.closure()?.reason ?? final.stopReason})`,
    );
  }
  return text;
}

/** End at the configured ceiling without turning a clean final answer into failure. */
export function turnLimiter(maxTurns: number, onToolLimit: () => void): FinishTurn {
  let completed = 0;
  return ({ message }) => {
    completed += 1;
    // Pi calls finishTurn on failures too. Preserve the provider error/abort truth.
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
    if (completed < maxTurns) return;
    if (message.content.some((block) => block.type === 'toolCall')) onToolLimit();
    // Also suppress queue polling after a clean final turn at the ceiling.
    return { action: 'end' };
  };
}

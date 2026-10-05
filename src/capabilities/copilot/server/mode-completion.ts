import {
  type CopilotModeState,
  CopilotSkillContext,
  type CopilotSkillContextT,
  readCopilotSkillTurn,
} from './chat-contracts';

export type CopilotTerminalOutcome =
  | {
      kind: 'success';
      learningContent: 'not_applicable' | 'passed' | 'blocked';
    }
  | { kind: 'partial' | 'failed' | 'cancelled' };

/**
 * Resolve product mode completion without adding transport or model-input state.
 * Teaching progress already comes from its behavior pack; quiz is the only
 * free-form one-shot mode. Legacy solve and old replies stay unclassified.
 */
export function resolveCopilotModeCompletion(
  skillContext: CopilotSkillContextT | undefined,
  outcome: CopilotTerminalOutcome,
): CopilotModeState | undefined {
  if (
    outcome.kind !== 'success' ||
    outcome.learningContent === 'blocked' ||
    skillContext?.skill !== 'quiz'
  ) {
    return undefined;
  }
  return {
    skill_turn: { kind: 'end' },
    skill_context: skillContext,
  };
}

/** Read only the completion shape this module writes; never infer legacy state. */
export function parseCopilotModeCompletion(
  payload: Record<string, unknown>,
): CopilotModeState | undefined {
  const turn = payload.skill_turn;
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return undefined;
  if ((turn as Record<string, unknown>).kind !== 'end') return undefined;
  const context = CopilotSkillContext.safeParse(payload.skill_context);
  if (!context.success || context.data.skill !== 'quiz') return undefined;
  return {
    skill_turn: { kind: 'end' },
    skill_context: context.data,
  };
}

/** Teaching progress and free-form completion share the same persisted product carrier. */
export function parseCopilotModeState(
  payload: Record<string, unknown>,
): CopilotModeState | undefined {
  const context = CopilotSkillContext.safeParse(payload.skill_context);
  if (!context.success || context.data.skill !== 'teaching')
    return parseCopilotModeCompletion(payload);
  const turn = readCopilotSkillTurn(payload);
  return turn ? { skill_turn: turn, skill_context: context.data } : undefined;
}

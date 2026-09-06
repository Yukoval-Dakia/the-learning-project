import type { ReplaySkillContext, ReplaySkillTurn } from './replay';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseSkillContext(value: unknown): ReplaySkillContext | undefined {
  const context = record(value);
  const ref = record(context?.ref);
  if (
    !context ||
    !ref ||
    (context.skill !== 'teaching' && context.skill !== 'quiz' && context.skill !== 'solve') ||
    typeof ref.kind !== 'string' ||
    !ref.kind ||
    typeof ref.id !== 'string' ||
    !ref.id
  )
    return undefined;
  return {
    skill: context.skill,
    ref: { kind: ref.kind, id: ref.id },
  };
}

export function parseSkillTurn(value: unknown): ReplaySkillTurn | undefined {
  const turn = record(value);
  if (!turn || (turn.kind !== 'explain' && turn.kind !== 'ask_check' && turn.kind !== 'end')) {
    return undefined;
  }
  const question = record(turn.structured_question);
  if (
    turn.kind === 'ask_check' &&
    (!question ||
      typeof question.id !== 'string' ||
      typeof question.kind !== 'string' ||
      typeof question.prompt_md !== 'string' ||
      !(
        question.choices_md === null ||
        (Array.isArray(question.choices_md) &&
          question.choices_md.every((choice) => typeof choice === 'string'))
      ))
  )
    return undefined;
  return {
    kind: turn.kind,
    ...(turn.kind === 'ask_check' && question
      ? {
          structured_question: {
            id: question.id as string,
            kind: question.kind as string,
            prompt_md: question.prompt_md as string,
            choices_md: question.choices_md as string[] | null,
          },
        }
      : {}),
    ...(turn.suggested_next === 'continue' || turn.suggested_next === 'end'
      ? { suggested_next: turn.suggested_next }
      : {}),
  };
}

/** Only explicit product state advances a mode. Legacy/failed replies preserve it. */
export function nextSkillContext(
  current: ReplaySkillContext | null,
  reply: { skill_turn?: ReplaySkillTurn; skill_context?: ReplaySkillContext },
): ReplaySkillContext | null {
  if (!reply.skill_turn) return current;
  if (reply.skill_turn.kind === 'end') return null;
  return reply.skill_context ?? current;
}

export function restoreSkillContext(
  messages: ReadonlyArray<{
    role: string;
    skill_turn?: ReplaySkillTurn;
    skill_context?: ReplaySkillContext;
  }>,
  current: ReplaySkillContext | null = null,
): ReplaySkillContext | null {
  return messages.reduce<ReplaySkillContext | null>(
    (current, message) => (message.role === 'ai' ? nextSkillContext(current, message) : current),
    current,
  );
}

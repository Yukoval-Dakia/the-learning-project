import { describe, expect, it } from 'vitest';
import { parseCopilotModeCompletion, resolveCopilotModeCompletion } from './mode-completion';

const quizContext = {
  skill: 'quiz' as const,
  ref: { kind: 'knowledge', id: 'knowledge_quadratic_discriminant' },
};

describe('Copilot mode completion', () => {
  it('uses the existing end turn for a successful one-shot quiz', () => {
    expect(
      resolveCopilotModeCompletion(quizContext, {
        kind: 'success',
        learningContent: 'passed',
      }),
    ).toEqual({
      skill_turn: { kind: 'end' },
      skill_context: quizContext,
    });
  });

  it.each(['partial', 'failed', 'cancelled'] as const)(
    'does not falsely end a quiz after %s execution',
    (outcome) => {
      expect(resolveCopilotModeCompletion(quizContext, { kind: outcome })).toBeUndefined();
    },
  );

  it('leaves teaching progress and legacy solve outside free-form completion', () => {
    expect(
      resolveCopilotModeCompletion(
        { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_1' } },
        { kind: 'success', learningContent: 'not_applicable' },
      ),
    ).toBeUndefined();
    expect(
      resolveCopilotModeCompletion(
        { skill: 'solve', ref: { kind: 'question', id: 'question_legacy' } },
        { kind: 'success', learningContent: 'not_applicable' },
      ),
    ).toBeUndefined();
    expect(
      resolveCopilotModeCompletion(undefined, {
        kind: 'success',
        learningContent: 'not_applicable',
      }),
    ).toBeUndefined();
  });

  it('does not end when learning-content validation had to block the quiz result', () => {
    expect(
      resolveCopilotModeCompletion(quizContext, {
        kind: 'success',
        learningContent: 'blocked',
      }),
    ).toBeUndefined();
  });

  it('recovers only the exact persisted quiz end pair and never guesses legacy state', () => {
    expect(
      parseCopilotModeCompletion({
        skill_turn: { kind: 'end' },
        skill_context: quizContext,
      }),
    ).toEqual({ skill_turn: { kind: 'end' }, skill_context: quizContext });
    expect(parseCopilotModeCompletion({ skill_context: quizContext })).toBeUndefined();
    expect(
      parseCopilotModeCompletion({
        skill_turn: { kind: 'end' },
        skill_context: { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_1' } },
      }),
    ).toBeUndefined();
  });
});

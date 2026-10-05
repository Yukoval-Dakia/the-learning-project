import { describe, expect, it } from 'vitest';
import type { ReplaySkillContext } from './replay';
import {
  nextSkillContext,
  parseSkillContext,
  parseSkillTurn,
  restoreSkillContext,
} from './skill-lifecycle';

const quiz: ReplaySkillContext = {
  skill: 'quiz',
  ref: { kind: 'knowledge', id: 'kc-磁场方向-42' },
};
const teaching: ReplaySkillContext = {
  skill: 'teaching',
  ref: { kind: 'learning_item', id: 'item-24' },
};

describe('explicit Copilot mode lifecycle', () => {
  it.each([quiz, teaching])('only an explicit end closes $skill', (context) => {
    expect(nextSkillContext(context, {})).toBe(context);
    expect(nextSkillContext(context, { skill_turn: { kind: 'explain' } })).toBe(context);
    expect(nextSkillContext(context, { skill_turn: { kind: 'end' } })).toBeNull();
  });
  it('replay folds end barriers without reviving an earlier teaching mode', () => {
    expect(
      restoreSkillContext([
        { role: 'ai', skill_turn: { kind: 'explain' }, skill_context: teaching },
        { role: 'user' },
        { role: 'ai', skill_turn: { kind: 'end' }, skill_context: quiz },
        { role: 'ai' },
      ]),
    ).toBeNull();
    expect(restoreSkillContext([{ role: 'ai', skill_context: quiz }])).toBeNull();
  });
  it('restores a later explicit continuation with its own context', () => {
    expect(
      restoreSkillContext([
        { role: 'ai', skill_turn: { kind: 'end' }, skill_context: quiz },
        { role: 'ai', skill_turn: { kind: 'explain' }, skill_context: teaching },
      ]),
    ).toEqual(teaching);
  });
  it('narrows malformed and private metadata before mode transitions', () => {
    expect(parseSkillTurn({ kind: 'unknown' })).toBeUndefined();
    expect(
      parseSkillTurn({ kind: 'ask_check', structured_question: { id: 'broken' } }),
    ).toBeUndefined();
    expect(parseSkillContext({ skill: 'quiz', ref: { id: 'missing-kind' } })).toBeUndefined();
    expect(
      parseSkillTurn({ kind: 'end', prompt: 'private', structured_question: { id: 'hidden' } }),
    ).toEqual({ kind: 'end' });
  });
});

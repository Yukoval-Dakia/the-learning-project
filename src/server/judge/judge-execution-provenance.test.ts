import { yuwenProfile } from '@/subjects/yuwen/profile';
import { describe, expect, it } from 'vitest';
import {
  JUDGE_PROMPT_TEMPLATE_REVISION,
  judgePromptFingerprint,
  taskInputHash,
} from './judge-execution-provenance';

describe('judge execution provenance identity', () => {
  it('canonicalizes task input key order', () => {
    expect(taskInputHash({ answer: { content: '甲' }, question: { id: 'q1' } })).toBe(
      taskInputHash({ question: { id: 'q1' }, answer: { content: '甲' } }),
    );
  });

  it('binds the prompt fingerprint to route, profile version, and rendered input', () => {
    const base = {
      taskKind: 'SemanticJudgeTask',
      taskInput: { question: { id: 'q1' }, answer: { content: '甲' } },
      subjectProfile: yuwenProfile,
      judgeRoute: 'semantic',
    } as const;
    const fingerprint = judgePromptFingerprint(base);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JUDGE_PROMPT_TEMPLATE_REVISION).toBe('judge-prompt-v1');
    expect(
      judgePromptFingerprint({
        ...base,
        taskInput: { answer: { content: '甲' }, question: { id: 'q1' } },
      }),
    ).toBe(fingerprint);
    expect(judgePromptFingerprint({ ...base, judgeRoute: 'steps' })).not.toBe(fingerprint);
    expect(
      judgePromptFingerprint({
        ...base,
        subjectProfile: { ...yuwenProfile, version: `${yuwenProfile.version}-other` },
      }),
    ).not.toBe(fingerprint);
    expect(
      judgePromptFingerprint({
        ...base,
        taskInput: { question: { id: 'q1' }, answer: { content: '乙' } },
      }),
    ).not.toBe(fingerprint);
  });
});

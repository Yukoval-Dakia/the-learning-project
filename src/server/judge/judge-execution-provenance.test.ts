import { createHash } from 'node:crypto';
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

  it('hashes actual byte content, not only byte length', () => {
    expect(taskInputHash(new Uint8Array([1, 2, 3]))).not.toBe(
      taskInputHash(new Uint8Array([1, 2, 4])),
    );
  });

  it('does not let a plain JSON object alias the versioned binary envelope', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    // A hand-crafted object shaped like the internal binary envelope must never
    // hash-collide with real binary data — the escape wrapper keeps them apart.
    const forgedEnvelope = {
      __ykv_canon__: {
        v: 1,
        t: 'bytes',
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
    expect(taskInputHash(forgedEnvelope)).not.toBe(taskInputHash(bytes));
    // A nested reserved-key object is likewise escaped rather than aliased.
    expect(taskInputHash({ __ykv_canon__: 'x' })).not.toBe(
      taskInputHash({ __ykv_canon__: { v: 1, t: 'bytes' } }),
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

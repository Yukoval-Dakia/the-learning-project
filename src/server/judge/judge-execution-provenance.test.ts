import { createHash } from 'node:crypto';
import { yuwenProfile } from '@/subjects/yuwen/profile';
import { describe, expect, it } from 'vitest';
import {
  JUDGE_PROMPT_TEMPLATE_REVISION,
  judgePromptFingerprint,
  sha256Canonical,
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

  // YUK-589 (J4c) — BigInt must produce a deterministic, non-colliding digest
  // instead of aborting the whole hash (JSON.stringify throws on a raw BigInt).
  it('canonicalizes BigInt into a deterministic, non-colliding digest without throwing', () => {
    expect(() => taskInputHash({ n: 10n })).not.toThrow();
    // Deterministic: the same BigInt hashes identically across calls.
    expect(taskInputHash({ n: 10n })).toBe(taskInputHash({ n: 10n }));
    // Distinct BigInts do not collide.
    expect(taskInputHash({ n: 10n })).not.toBe(taskInputHash({ n: 11n }));
    // A BigInt and the equal Number render to different envelopes → never alias.
    expect(taskInputHash({ n: 10n })).not.toBe(taskInputHash({ n: 10 }));
    // Nor does a BigInt alias the decimal string that spells it.
    expect(taskInputHash({ n: 10n })).not.toBe(taskInputHash({ n: '10' }));
  });

  // YUK-589 (J4c) — exotic non-plain objects (Map/Set/RegExp) silently serialized
  // as `{}` before, colliding every distinct instance. They must now throw so the
  // caller's fail-closed guard skips the fingerprint instead of trusting a
  // colliding hash.
  it.each([
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1, 2, 3])],
    ['RegExp', /abc/g],
    ['ArrayBuffer', new ArrayBuffer(8)],
  ])(
    'refuses to canonicalize an exotic %s value (throws, never collides as {})',
    (_label, value) => {
      expect(() => taskInputHash({ exotic: value })).toThrow(/non-canonicalizable/);
      expect(() => sha256Canonical(value)).toThrow(/non-canonicalizable/);
    },
  );

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

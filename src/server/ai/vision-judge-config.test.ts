import { afterEach, describe, expect, it, vi } from 'vitest';
import { visionJudgeProviderOverride } from './vision-judge-config';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('visionJudgeProviderOverride', () => {
  it('returns undefined when VISION_JUDGE_PROVIDER is unset (dark-ship default)', () => {
    expect(visionJudgeProviderOverride({})).toBeUndefined();
  });

  it('returns {provider} for anthropic-sub when the OAuth token is present', () => {
    const result = visionJudgeProviderOverride({
      VISION_JUDGE_PROVIDER: 'anthropic-sub',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok-123',
    });
    expect(result).toEqual({ provider: 'anthropic-sub', model: undefined });
  });

  it('threads VISION_JUDGE_MODEL when set', () => {
    const result = visionJudgeProviderOverride({
      VISION_JUDGE_PROVIDER: 'anthropic-sub',
      VISION_JUDGE_MODEL: 'claude-opus-4-8',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok-123',
    });
    expect(result).toEqual({ provider: 'anthropic-sub', model: 'claude-opus-4-8' });
  });

  it('degrades to undefined (+ warns on the call) for anthropic-sub when the OAuth token is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = visionJudgeProviderOverride({ VISION_JUDGE_PROVIDER: 'anthropic-sub' });
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('CLAUDE_CODE_OAUTH_TOKEN missing');
  });

  it('returns a non-oauth provider as-is (no token check, trust operator)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = visionJudgeProviderOverride({ VISION_JUDGE_PROVIDER: 'xiaomi' });
    expect(result).toEqual({ provider: 'xiaomi', model: undefined });
    expect(warn).not.toHaveBeenCalled();
  });
});

// YUK-924 site 4 — vision-capability availability from the ModelProfile
// registry. The cases above are the pre-existing characterization (kept
// byte-identical); these pin the profile half: a lane whose nameable model
// CONFIRMS no vision input degrades exactly like the OAuth-token-missing case,
// while 'unknown' and unnamed-model lanes pass through unchanged.
describe('visionJudgeProviderOverride — YUK-924 vision-capability availability', () => {
  it('degrades to undefined (+ warns) when the named model confirms NO vision input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = visionJudgeProviderOverride({
      VISION_JUDGE_PROVIDER: 'zhipu',
      VISION_JUDGE_MODEL: 'glm-5.2', // catalog: text-only
    });
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('whose profile confirms NO vision input');
  });

  it('passes the named model through when the profile confirms vision (claude)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = visionJudgeProviderOverride({
      VISION_JUDGE_PROVIDER: 'anthropic',
      VISION_JUDGE_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_API_KEY: 'sk-test',
    });
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('checks the anthropic-sub built-in default model when VISION_JUDGE_MODEL is unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // claude-opus-4-8 is vision-capable → override survives.
    expect(
      visionJudgeProviderOverride({
        VISION_JUDGE_PROVIDER: 'anthropic-sub',
        CLAUDE_CODE_OAUTH_TOKEN: 'tok-123',
      }),
    ).toEqual({ provider: 'anthropic-sub', model: undefined });
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves lanes without a nameable model unchecked (byte-identical pass-through)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // xiaomi without VISION_JUDGE_MODEL: the effective model is the judge task's
    // registry default, invisible here — pre-YUK-924 behaviour, kept as-is.
    expect(visionJudgeProviderOverride({ VISION_JUDGE_PROVIDER: 'xiaomi' })).toEqual({
      provider: 'xiaomi',
      model: undefined,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an unknown model id (vision unknown) passes through; the runTask gate owns the lane', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      visionJudgeProviderOverride({
        VISION_JUDGE_PROVIDER: 'zhipu',
        VISION_JUDGE_MODEL: 'glm-future-unknown',
      }),
    ).toEqual({ provider: 'zhipu', model: 'glm-future-unknown' });
    expect(warn).not.toHaveBeenCalled();
  });
});

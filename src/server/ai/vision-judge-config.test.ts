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

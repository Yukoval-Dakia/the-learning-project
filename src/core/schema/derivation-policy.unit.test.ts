import { describe, expect, it } from 'vitest';
import { CopilotChatRequest } from '@/capabilities/copilot/server/chat-contracts';
import { readDerivationPolicy } from './derivation-policy';

describe('turn derivation boundary', () => {
  it('preserves missing policy in legacy normalized requests and rejects invalid explicit values', () => {
    const legacy = {
      user_message: '核对椭圆参数、退化焦点与独立迁移证据；只讨论假设，不把一句解释当作已经掌握。',
      triggered_by: 'chat',
    };
    const parsed = CopilotChatRequest.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(readDerivationPolicy(parsed)).toBe('allow');
    expect(
      CopilotChatRequest.parse({ ...legacy, derivation_policy: 'answer_only' }).derivation_policy,
    ).toBe('answer_only');
    for (const policy of ['temporary', '', null, false, { mode: 'allow' }])
      expect(CopilotChatRequest.safeParse({ ...legacy, derivation_policy: policy }).success).toBe(
        false,
      );
  });
});

import { describe, expect, it } from 'vitest';
import { agentMeta, signalMeta } from './meta';

describe('agentMeta', () => {
  it('resolves known source_task_kind values', () => {
    expect(agentMeta('quiz_verify')).toEqual({ label: '出题校验', icon: 'quiz' });
    expect(agentMeta('attribution').label).toBe('错因归因');
    expect(agentMeta('copilot').icon).toBe('copilot');
  });

  it('resolves known target_agents enum values', () => {
    expect(agentMeta('dreaming').label).toBe('夜间推理');
    expect(agentMeta('maintenance').label).toBe('维护');
    expect(agentMeta('coach').label).toBe('教练');
  });

  it('未知 kind 退化为用户可读标签，不泄漏内部枚举', () => {
    expect(agentMeta('brand_new_agent')).toEqual({ label: '其他 AI 工作', icon: 'sparkle' });
  });

  it('does not throw on empty string', () => {
    expect(() => agentMeta('')).not.toThrow();
    expect(agentMeta('').label).toBe('其他 AI 工作');
    expect(agentMeta('').icon).toBe('sparkle');
  });
});

describe('signalMeta', () => {
  it('resolves known signal_kind values with their tone', () => {
    expect(signalMeta('question_pool_gap')).toEqual({ label: '题池缺口', tone: 'hard' });
    expect(signalMeta('misconception').tone).toBe('info');
    expect(signalMeta('quality').tone).toBe('good');
    expect(signalMeta('offtopic').tone).toBe('coral');
  });

  it('未知信号退化为用户可读标签，不泄漏内部枚举', () => {
    expect(signalMeta('weird_new_signal')).toEqual({ label: '其他信号', tone: 'neutral' });
  });

  it('does not throw on empty string', () => {
    expect(() => signalMeta('')).not.toThrow();
    expect(signalMeta('').tone).toBe('neutral');
  });
});

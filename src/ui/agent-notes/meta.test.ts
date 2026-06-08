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

  it('falls back for an unknown kind: raw kind as label + generic icon', () => {
    expect(agentMeta('brand_new_agent')).toEqual({ label: 'brand_new_agent', icon: 'sparkle' });
  });

  it('does not throw on empty string', () => {
    expect(() => agentMeta('')).not.toThrow();
    expect(agentMeta('').label).toBe('');
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

  it('falls back for an unknown signal: raw kind as label + neutral tone', () => {
    expect(signalMeta('weird_new_signal')).toEqual({ label: 'weird_new_signal', tone: 'neutral' });
  });

  it('does not throw on empty string', () => {
    expect(() => signalMeta('')).not.toThrow();
    expect(signalMeta('').tone).toBe('neutral');
  });
});

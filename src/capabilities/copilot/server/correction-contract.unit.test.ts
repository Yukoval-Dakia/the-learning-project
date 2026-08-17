import { describe, expect, it } from 'vitest';

import { resolveCorrectionReply, resolveImplicitCorrectionContract } from './correction-contract';

const correctionContract = {
  available_prior_turn_ids: ['copilot_reply_water_tank_d02', 'copilot_reply_battery_d04'],
  prior_turn_summaries: {
    copilot_reply_water_tank_d02: '水箱 D02：h*=4/9，使用同一个 k。',
    copilot_reply_battery_d04: '电池 D04：先按当前电量估算。',
  },
  required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
} as const;

describe('resolveCorrectionReply', () => {
  it('fails closed when an explicit target reply omits the correction envelope', () => {
    const targetId = 'copilot_reply_water_tank_d02';

    const result = resolveCorrectionReply('已把水箱题改正为 h*=4/9，k 不变。', {
      target_prior_turn_id: targetId,
      available_prior_turn_ids: [targetId, 'copilot_reply_battery_d04'],
      prior_turn_summaries: {
        [targetId]: '水箱 D02：h*=4/9，使用同一个 k。',
        copilot_reply_battery_d04: '电池 D04：先按当前电量估算。',
      },
      required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
    });

    expect(result.kind).toBe('clarify');
    expect(result.reply).toContain('上一轮是「电池 D04：先按当前电量估算。」');
    expect(result.reply).toContain('上上轮是「水箱 D02：h*=4/9，使用同一个 k。」');
    expect(result.reply).not.toContain('已把水箱题改正');
  });

  it('keeps only the explicit target and renders changed retained and uncertain facts', () => {
    const targetId = 'copilot_reply_water_tank_d02';

    const result = resolveCorrectionReply(
      '水箱更正后的推导。\n\n<!-- copilot-correction {"prior_turn_id":"copilot_reply_water_tank_d02","changed":["h*=4/9"],"retained":["同一个 k"],"uncertain":["容器截面积未给出"]} -->',
      {
        target_prior_turn_id: targetId,
        available_prior_turn_ids: [targetId, 'copilot_reply_battery_d04'],
        prior_turn_summaries: {
          [targetId]: '水箱 D02：h*=4/9，使用同一个 k。',
          copilot_reply_battery_d04: '电池 D04：先按当前电量估算。',
        },
        required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
      },
    );

    expect(result).toEqual({
      kind: 'corrected',
      reply:
        '水箱更正后的推导。\n\n更正目标 prior_turn_id：copilot_reply_water_tank_d02\n已变更：h*=4/9\n保留：同一个 k\n不确定：容器截面积未给出',
    });
  });

  it('binds an unambiguous implicit correction to its sole prior-turn candidate', () => {
    const result = resolveImplicitCorrectionContract(correctionContract, {
      intent: 'correction',
      candidate_prior_turn_ids: ['copilot_reply_battery_d04'],
    });

    expect(result).toEqual({
      kind: 'bound',
      contract: {
        ...correctionContract,
        target_prior_turn_id: 'copilot_reply_battery_d04',
      },
    });
  });

  it('clarifies an implicit correction with multiple prior-turn candidates', () => {
    const result = resolveImplicitCorrectionContract(correctionContract, {
      intent: 'correction',
      candidate_prior_turn_ids: ['copilot_reply_water_tank_d02', 'copilot_reply_battery_d04'],
    });

    expect(result.kind).toBe('clarify');
    if (result.kind !== 'clarify') throw new Error('expected an ambiguous correction to clarify');
    expect(result.reply).toContain('上一轮是「电池 D04：先按当前电量估算。」');
    expect(result.reply).toContain('上上轮是「水箱 D02：h*=4/9，使用同一个 k。」');
  });

  it('lists only the classifier candidates when they are a subset of history', () => {
    const result = resolveImplicitCorrectionContract(
      {
        available_prior_turn_ids: [
          'copilot_reply_water_tank_d02',
          'copilot_reply_battery_d04',
          'copilot_reply_circuit_d05',
          'copilot_reply_optics_d06',
          'copilot_reply_kinematics_d07',
        ],
        prior_turn_summaries: {
          copilot_reply_water_tank_d02: '水箱 D02：h*=4/9，使用同一个 k。',
          copilot_reply_battery_d04: '电池 D04：先按当前电量估算。',
          copilot_reply_circuit_d05: '电路 D05：串联等效电阻。',
          copilot_reply_optics_d06: '光学 D06：折射率计算。',
          copilot_reply_kinematics_d07: '运动学 D07：匀加速位移。',
        },
        required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
      },
      {
        intent: 'correction',
        candidate_prior_turn_ids: ['copilot_reply_water_tank_d02', 'copilot_reply_battery_d04'],
      },
    );

    expect(result.kind).toBe('clarify');
    if (result.kind !== 'clarify') throw new Error('expected an ambiguous correction to clarify');
    expect(result.reply).toContain('往前第 4 轮是「电池 D04：先按当前电量估算。」');
    expect(result.reply).toContain('往前第 5 轮是「水箱 D02：h*=4/9，使用同一个 k。」');
    expect(result.reply).not.toContain('电路 D05');
    expect(result.reply).not.toContain('光学 D06');
    expect(result.reply).not.toContain('运动学 D07');
  });

  it('gives deterministic copy when no classifier candidate is available', () => {
    const result = resolveImplicitCorrectionContract(correctionContract, {
      intent: 'correction',
      candidate_prior_turn_ids: ['copilot_reply_optics_d06'],
    });

    expect(result.kind).toBe('clarify');
    if (result.kind !== 'clarify') throw new Error('expected a clarify resolution');
    expect(result.reply).not.toContain('copilot_reply_optics_d06');
    expect(result.reply).not.toContain('可选历史回复');
  });

  it('leaves an ordinary follow-up outside the correction contract', () => {
    const result = resolveImplicitCorrectionContract(correctionContract, {
      intent: 'not_correction',
    });

    expect(result).toEqual({ kind: 'normal', contract: correctionContract });
  });
});

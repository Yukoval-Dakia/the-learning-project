import { describe, expect, it } from 'vitest';

import { resolveCorrectionReply } from './correction-contract';

describe('resolveCorrectionReply', () => {
  it('keeps only the explicit target and renders changed retained and uncertain facts', () => {
    const targetId = 'copilot_reply_water_tank_d02';

    const result = resolveCorrectionReply(
      '水箱更正后的推导。\n\n<!-- copilot-correction {"prior_turn_id":"copilot_reply_water_tank_d02","changed":["h*=4/9"],"retained":["同一个 k"],"uncertain":["容器截面积未给出"]} -->',
      {
        target_prior_turn_id: targetId,
        available_prior_turn_ids: [targetId, 'copilot_reply_battery_d04'],
        required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
      },
    );

    expect(result).toEqual({
      kind: 'corrected',
      reply:
        '水箱更正后的推导。\n\n更正目标 prior_turn_id：copilot_reply_water_tank_d02\n已变更：h*=4/9\n保留：同一个 k\n不确定：容器截面积未给出',
    });
  });
});

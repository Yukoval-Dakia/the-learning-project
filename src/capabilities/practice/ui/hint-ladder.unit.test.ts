// YUK-354 (A2) — 解题会话 6 阶强度梯纯模型单测（无 DB，unit 分区）。
//
// HintLadder 组件没有 render 测试 harness（项目不带 jsdom/testing-library，引入属 scope creep，
// 同 PfSolo.detection.unit.test.ts）。强度梯的形态不变式被抽成纯函数（阶定义 + 位置推导 +
// 单调递进的下一阶 + 完整解可用判定），它们就是组件状态机的唯一真相源——这里固定它们。

import { describe, expect, it } from 'vitest';

import {
  FULL_STAGE_INDEX,
  HINT_LADDER,
  LADDER_RANGE_LABEL,
  LADDER_SIZE,
  LAST_HINT_INDEX,
  isFullSolutionAvailable,
  nextHintStage,
  positionLabel,
  stageAt,
} from './hint-ladder';

describe('HINT_LADDER — owner 锁定的 6 阶 H0-H5', () => {
  it('恰好 6 阶，key 依次 H0..H5', () => {
    expect(LADDER_SIZE).toBe(6);
    expect(HINT_LADDER.map((s) => s.key)).toEqual(['H0', 'H1', 'H2', 'H3', 'H4', 'H5']);
  });

  it('只有 H5 是 isFull（完整解 = 逃生口的 reveal，非 hint 调用）', () => {
    const fullStages = HINT_LADDER.filter((s) => s.isFull);
    expect(fullStages).toHaveLength(1);
    expect(fullStages[0].key).toBe('H5');
    expect(FULL_STAGE_INDEX).toBe(5);
  });

  it('最高 hint 阶 = H4 = 索引 4（远低于后端 MAX_HINT_INDEX=20，梯内不触发后端 exhausted）', () => {
    expect(LAST_HINT_INDEX).toBe(4);
    expect(HINT_LADDER[LAST_HINT_INDEX].key).toBe('H4');
    expect(HINT_LADDER[LAST_HINT_INDEX].isFull).toBe(false);
  });

  it('量程标签 = H0–H5', () => {
    expect(LADDER_RANGE_LABEL).toBe('H0–H5');
  });

  it('独立性语义：H0-H3 独立、H4 半独立、H5 非独立（仅 H5 驱动确认门）', () => {
    expect(HINT_LADDER.map((s) => s.independence)).toEqual([
      'independent',
      'independent',
      'independent',
      'independent',
      'semi',
      'non',
    ]);
  });

  it('每阶都带可感知的强度档位 weight + 非空「性质」预告 gives', () => {
    for (const s of HINT_LADDER) {
      expect(s.weight.length).toBeGreaterThan(0);
      expect(s.gives.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });
});

describe('stageAt', () => {
  it('返回对应阶；越界返回 undefined', () => {
    expect(stageAt(0)?.key).toBe('H0');
    expect(stageAt(5)?.key).toBe('H5');
    expect(stageAt(-1)).toBeUndefined();
    expect(stageAt(6)).toBeUndefined();
  });
});

describe('positionLabel — rail 右侧位置刻度', () => {
  it('尚未开始（reached < 0）', () => {
    expect(positionLabel(-1, false)).toBe('尚未开始');
  });

  it('要到某阶 → 第 H{n} 阶', () => {
    expect(positionLabel(0, false)).toBe('第 H0 阶');
    expect(positionLabel(3, false)).toBe('第 H3 阶');
    expect(positionLabel(4, false)).toBe('第 H4 阶');
  });

  it('reveal 完整解后恒为「已看完整解」（即便 reached 仍指中间阶）', () => {
    expect(positionLabel(5, true)).toBe('已看完整解');
    expect(positionLabel(2, true)).toBe('已看完整解');
    expect(positionLabel(-1, true)).toBe('已看完整解');
  });
});

describe('nextHintStage — 单调递进、不跳级、不返回完整解阶', () => {
  it('尚未开始（-1）→ 首阶 H0（首次推进 = 最轻一阶）', () => {
    expect(nextHintStage(-1)?.key).toBe('H0');
  });

  it('逐阶 +1 推进 H0→H1→…→H4', () => {
    expect(nextHintStage(0)?.key).toBe('H1');
    expect(nextHintStage(1)?.key).toBe('H2');
    expect(nextHintStage(2)?.key).toBe('H3');
    expect(nextHintStage(3)?.key).toBe('H4');
  });

  it('到 H4（4）后下一阶是 H5 完整解 → 返回 undefined（此后只剩逃生口，「再给一阶」不可滑到 H5）', () => {
    expect(nextHintStage(LAST_HINT_INDEX)).toBeUndefined();
    expect(nextHintStage(4)).toBeUndefined();
  });

  it('已在完整解阶（5）→ undefined', () => {
    expect(nextHintStage(5)).toBeUndefined();
  });
});

describe('isFullSolutionAvailable — H5 逃生口是否有可展示完整解', () => {
  it('有非空 reference_md → 可用', () => {
    expect(isFullSolutionAvailable('完整解答……')).toBe(true);
  });

  it('null / undefined / 空串 / 纯空白 → 不可用（走诚实空态，不给死按钮）', () => {
    expect(isFullSolutionAvailable(null)).toBe(false);
    expect(isFullSolutionAvailable(undefined)).toBe(false);
    expect(isFullSolutionAvailable('')).toBe(false);
    expect(isFullSolutionAvailable('   \n  ')).toBe(false);
  });
});

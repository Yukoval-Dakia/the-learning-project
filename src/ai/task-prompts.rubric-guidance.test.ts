// YUK-600（判词 R / v3 §4，验收 §8-10/19/20）— rubricGuidance/methodology 注入合同：
//   - 四锚点各自独立正测（quiz-gen 生成 / question_author / sourcing 提取 /
//     教学 ask-check——不合并断言，§8-10 原文）；
//   - **judge 读端 byte-diff 为零**（QuizVerify + 三 judge task——排除是合同不是巧合）；
//   - 排除表负测（solution-generate 等 backfill 路径 byte-diff 零，§8-20）；
//   - methodology → copilot 教学 / note 生成 prompt（空串 → prompt 零变化，§8-19）。
// 纯函数零 IO；src/ai/** 由 fastTestInclude glob 收编。

import { subjectProfiles } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { type AiTaskKind, getTaskSystemPrompt } from './task-prompts';

// biome-ignore lint/style/noNonNullAssertion: builtin 恒在
const base = subjectProfiles.yuwen!;
const RUBRIC = '采分点必须逐条可判，禁止「言之有理即可」';
const METHOD = '先声明前提，再逐步推导';

function withSections(rubricGuidance: string, methodology: string) {
  return {
    ...base,
    promptFragments: { ...base.promptFragments, rubricGuidance, methodology },
  };
}

const FOUR_ANCHORS: AiTaskKind[] = [
  'QuizGenTask',
  'QuestionAuthorTask',
  'SourcingTask',
  'TeachingTurnTask',
];

// judge 读端 + backfill 排除表（v3 §4.1/§4.2：动它们 = 改判分行为，二期 calibration-gated）。
const EXCLUDED: AiTaskKind[] = [
  'QuizVerifyTask',
  'SemanticJudgeTask',
  'StepsJudgeTask',
  'MultimodalDirectJudgeTask',
  'SolutionGenerateTask',
  'MistakeEnrollTask',
];

describe('rubricGuidance 四锚点各自独立正测（§8-10）', () => {
  for (const task of FOUR_ANCHORS) {
    it(`${task} 的 prompt 含 rubricGuidance 节`, () => {
      const prompt = getTaskSystemPrompt(task, withSections(RUBRIC, ''));
      expect(prompt).toContain(RUBRIC);
      expect(prompt).toContain('科目级 rubric 规范');
    });
  }

  it('空串 → 四锚点 prompt 与今日逐字节一致（一期零扰动口径）', () => {
    for (const task of FOUR_ANCHORS) {
      expect(getTaskSystemPrompt(task, withSections('', ''))).toBe(getTaskSystemPrompt(task, base));
    }
  });
});

describe('judge 读端与排除表 byte-diff 为零（§8-10 负测 + §8-20）', () => {
  for (const task of EXCLUDED) {
    it(`${task} 在 rubricGuidance 非空时 prompt 逐字节不变`, () => {
      expect(getTaskSystemPrompt(task, withSections(RUBRIC, ''))).toBe(
        getTaskSystemPrompt(task, base),
      );
    });
  }
});

describe('methodology 注入（§8-19）', () => {
  it('TeachingTurnTask / NoteGenerateTask 含方法论段；空串零变化', () => {
    for (const task of ['TeachingTurnTask', 'NoteGenerateTask'] as AiTaskKind[]) {
      const prompt = getTaskSystemPrompt(task, withSections('', METHOD));
      expect(prompt).toContain(METHOD);
      expect(prompt).toContain('科目方法论');
      expect(getTaskSystemPrompt(task, withSections('', ''))).toBe(getTaskSystemPrompt(task, base));
    }
  });

  it('methodology 不漏进 judge 读端', () => {
    expect(getTaskSystemPrompt('QuizVerifyTask', withSections('', METHOD))).toBe(
      getTaskSystemPrompt('QuizVerifyTask', base),
    );
  });
});

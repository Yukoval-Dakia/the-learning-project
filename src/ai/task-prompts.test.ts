import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { getTaskSystemPrompt } from './task-prompts';

describe('getTaskSystemPrompt', () => {
  it('preserves the current wenyan NoteGenerateTask prompt by default', () => {
    const prompt = getTaskSystemPrompt('NoteGenerateTask');

    expect(prompt).toContain('你是学习笔记作者');
    expect(prompt).toContain('优先使用原文短句');
    expect(prompt).toContain('材料不足时标注不确定');
  });

  it('builds a math NoteGenerateTask prompt without wenyan examples', () => {
    const prompt = getTaskSystemPrompt('NoteGenerateTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('你是数学学习笔记作者');
    expect(prompt).toContain('每一步变形依据');
    expect(prompt).toContain('条件不足时指出缺少的条件');
    expect(prompt).not.toContain('古文');
  });

  it('builds subject-specific TeachingTurnTask prompts', () => {
    const wenyan = getTaskSystemPrompt('TeachingTurnTask');
    const math = getTaskSystemPrompt('TeachingTurnTask', resolveSubjectProfile('math'));

    expect(wenyan).toContain('你是文言文学习教练');
    expect(wenyan).toContain('定位文本证据');
    expect(math).toContain('你是数学学习教练');
    expect(math).toContain('检查条件和目标');
    expect(math).not.toContain('文言文');
  });

  it('builds subject-specific AttributionTask prompts', () => {
    const prompt = getTaskSystemPrompt('AttributionTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('科目上下文：数学');
    expect(prompt).toContain('数学定义、定理、条件');
    expect(prompt).toContain('你是错题归因助手');
    expect(prompt).not.toContain('文言文');
  });

  it('builds subject-specific KnowledgeProposeTask prompts', () => {
    const prompt = getTaskSystemPrompt('KnowledgeProposeTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('科目上下文：数学');
    expect(prompt).toContain('题面条件、定义、定理或用户已有步骤');
    expect(prompt).not.toContain('虚词');
  });
});

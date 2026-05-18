import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { getTaskSystemPrompt } from './task-prompts';

describe('getTaskSystemPrompt', () => {
  it('preserves the current wenyan NoteGenerateTask prompt by default', () => {
    const prompt = getTaskSystemPrompt('NoteGenerateTask');

    expect(prompt).toContain('你是学习笔记作者');
    expect(prompt).toContain('文言文示例首选经典原文');
    expect(prompt).toContain('《师说》');
  });

  it('builds a math NoteGenerateTask prompt without wenyan examples', () => {
    const prompt = getTaskSystemPrompt('NoteGenerateTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('你是数学学习笔记作者');
    expect(prompt).toContain('推导');
    expect(prompt).toContain('单位');
    expect(prompt).not.toContain('文言文');
    expect(prompt).not.toContain('《师说》');
  });

  it('builds subject-specific TeachingTurnTask prompts', () => {
    const wenyan = getTaskSystemPrompt('TeachingTurnTask');
    const math = getTaskSystemPrompt('TeachingTurnTask', resolveSubjectProfile('math'));

    expect(wenyan).toContain('你是文言文学习教练');
    expect(math).toContain('你是数学学习教练');
    expect(math).toContain('步骤');
    expect(math).not.toContain('文言文经典原文');
  });

  it('keeps unsupported tasks on their registry prompt', () => {
    const prompt = getTaskSystemPrompt('AttributionTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('你是错题归因助手');
  });
});

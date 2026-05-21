import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { tasks } from './registry';
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

  it('builds NoteVerifyTask prompt from the subject profile', () => {
    const prompt = getTaskSystemPrompt('NoteVerifyTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('你是数学学习笔记质检员');
    expect(prompt).toContain('NoteVerificationResult');
    expect(prompt).toContain('factuality');
    expect(prompt).toContain('subject_fit');
    expect(prompt).toContain('条件不足时指出缺少的条件');
    expect(prompt).not.toContain('文言文经典原文');
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
    expect(prompt).toContain('unit_error');
    expect(prompt).toContain('当前 SubjectProfile');
    expect(prompt).not.toContain('universal baseline');
    expect(prompt).not.toContain('time_pressure');
    expect(prompt).toContain('你是错题归因助手');
    expect(prompt).not.toContain('文言文');
    expect(prompt).not.toContain('古文');
  });

  it('builds subject-specific KnowledgeProposeTask prompts', () => {
    const prompt = getTaskSystemPrompt('KnowledgeProposeTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('科目上下文：数学');
    expect(prompt).toContain('题面条件、定义、定理或用户已有步骤');
    expect(prompt).not.toContain('虚词');
  });

  it('builds VariantGenTask prompt from the subject cause taxonomy', () => {
    const prompt = getTaskSystemPrompt('VariantGenTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('科目上下文：数学');
    expect(prompt).toContain('unit_error');
    expect(prompt).toContain('单位错误');
    expect(prompt).toContain('当前 SubjectProfile cause taxonomy');
    expect(prompt).not.toContain('time_pressure');
  });

  it('builds subject-specific SessionSummaryTask prompts', () => {
    const prompt = getTaskSystemPrompt('SessionSummaryTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('科目上下文：数学');
    expect(prompt).toContain('条件和目标');
    expect(prompt).not.toContain('文言文');
  });

  it('builds subject-specific KnowledgeReviewTask prompts', () => {
    const prompt = getTaskSystemPrompt('KnowledgeReviewTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('科目上下文：数学');
    expect(prompt).toContain('数学定义、条件、方法或易错模式');
    expect(prompt).toContain('mcp__loom__write_proposal');
    expect(prompt).not.toContain('文言文');
  });

  it('builds EmbeddedCheckGenerateTask prompt from the subject profile', () => {
    const wenyan = getTaskSystemPrompt('EmbeddedCheckGenerateTask');
    const math = getTaskSystemPrompt('EmbeddedCheckGenerateTask', resolveSubjectProfile('math'));

    // Subject voice still flows in via displayName + checkQuestionPolicy
    expect(wenyan).toContain('文言文');
    expect(wenyan).toContain('检查题应短小，聚焦一个词义、句式或翻译判断。');
    expect(math).toContain('数学');
    expect(math).toContain('检查题应聚焦一个公式、条件判断或关键变形。');

    // Prompt must only reference canonical QuestionKind values — subject-only
    // kinds like 'single_choice'/'multiple_choice'/'reading_comprehension'/
    // 'calculation'/'proof'/'word_problem' fail EmbeddedCheckQuestionSchema and
    // must NOT leak into the prompt instructions (PR #76 review P1).
    for (const prompt of [wenyan, math]) {
      expect(prompt).toContain('EmbeddedCheckQuestion');
      expect(prompt).toContain('kind');
      expect(prompt).toContain('reference_md');
      // Canonical kinds appear (at least one must be referenced explicitly)
      expect(prompt).toMatch(/\bchoice\b/);
      expect(prompt).toMatch(/\bfill_blank\b/);
      // Subject-only kinds must NOT appear
      expect(prompt).not.toMatch(/\bsingle_choice\b/);
      expect(prompt).not.toMatch(/\bmultiple_choice\b/);
      expect(prompt).not.toMatch(/\breading_comprehension\b/);
      expect(prompt).not.toMatch(/\bcalculation\b/);
      expect(prompt).not.toMatch(/\bword_problem\b/);
      expect(prompt).not.toMatch(/\bproof\b/);
    }
  });
});

describe('getTaskSystemPrompt exhaustiveness (M1)', () => {
  const allTaskKinds = Object.keys(tasks) as Array<keyof typeof tasks>;

  it('renders a non-empty prompt for every registered TaskKind (default profile)', () => {
    for (const kind of allTaskKinds) {
      const prompt = getTaskSystemPrompt(kind);
      expect(prompt, `TaskKind '${kind}' returned empty prompt`).toBeTruthy();
      expect(prompt.length, `TaskKind '${kind}' returned too-short prompt`).toBeGreaterThan(20);
    }
  });

  it('renders a non-empty prompt for every registered TaskKind (math profile)', () => {
    const mathProfile = resolveSubjectProfile('math');
    for (const kind of allTaskKinds) {
      const prompt = getTaskSystemPrompt(kind, mathProfile);
      expect(prompt, `TaskKind '${kind}' returned empty prompt (math)`).toBeTruthy();
    }
  });

  it('Vision* and ReviewIntentTask use subject-neutral registry strings', () => {
    // These 3 tasks pass through to registry.ts. Their prompts should be
    // identical regardless of profile.
    const wenyanProfile = resolveSubjectProfile('wenyan');
    const mathProfile = resolveSubjectProfile('math');
    for (const kind of ['VisionExtractTask', 'VisionExtractTaskHeavy', 'ReviewIntentTask'] as const) {
      const w = getTaskSystemPrompt(kind, wenyanProfile);
      const m = getTaskSystemPrompt(kind, mathProfile);
      expect(w, `${kind} profile-coupling regression`).toBe(m);
      expect(w).toBe(tasks[kind].systemPrompt);
    }
  });
});

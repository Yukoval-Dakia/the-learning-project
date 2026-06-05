import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { tasks } from './registry';
import { getTaskSystemPrompt } from './task-prompts';

describe('getTaskSystemPrompt', () => {
  it('preserves the current wenyan NoteGenerateTask prompt by default', () => {
    const prompt = getTaskSystemPrompt('NoteGenerateTask');

    expect(prompt).toContain('你是学习笔记作者');
    expect(prompt).toContain('artifact_type');
    expect(prompt).toContain('body_blocks');
    expect(prompt).toContain('note_atomic');
    expect(prompt).toContain('note_long');
    expect(prompt).toContain('note_hub');
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
    expect(prompt).toContain('artifact_type');
    expect(prompt).toContain('body_blocks');
    expect(prompt).toContain('block_summaries');
    expect(prompt).toContain('NoteVerificationResult');
    expect(prompt).toContain('factuality');
    expect(prompt).toContain('subject_fit');
    expect(prompt).toContain('条件不足时指出缺少的条件');
    expect(prompt).not.toContain('文言文经典原文');
  });

  it('builds LearningIntentOutlineTask prompt with optional long notes', () => {
    const prompt = getTaskSystemPrompt('LearningIntentOutlineTask', resolveSubjectProfile('math'));

    expect(prompt).toContain('longs');
    expect(prompt).toContain('knowledge_ids');
    expect(prompt).toContain('0-M');
    expect(prompt).toContain('3b: {"knowledge":{"children"');
    expect(prompt).toContain('3b 不要输出 root');
    expect(prompt).toContain(
      '3b: longs[].knowledge_ids 只能使用 knowledge_node.id 或 knowledge.children[].temp_id',
    );
    expect(prompt).not.toContain('3a/3b: {"knowledge":{"root"');
    expect(prompt).not.toContain('3a/3b: longs[].knowledge_ids 只能使用 knowledge.root.temp_id');
  });

  it('keeps DreamingTask focused on bounded tool-written proposals', () => {
    const prompt = getTaskSystemPrompt('DreamingTask');

    expect(prompt).toContain('DomainTools');
    expect(prompt).toContain('propose_*');
    expect(prompt).toContain('不要直接修改');
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
    expect(prompt).toContain('time_pressure');
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
    expect(prompt).toContain('time_pressure');
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
    expect(wenyan).toContain('body_blocks');
    expect(wenyan).toContain('tool_quiz');
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

  it('builds a math SolutionGenerateTask prompt grounded in reference_solution shape', () => {
    const prompt = getTaskSystemPrompt('SolutionGenerateTask', resolveSubjectProfile('math'));
    expect(prompt).toContain('expected_signals');
    expect(prompt).toContain('final_answer');
    expect(prompt).toContain('answer_equivalents');
    expect(prompt).toContain('worked_solution_md');
    expect(prompt).toContain('choices_md');
    expect(prompt).toContain('数学');
    // existing answers/analysis are advisory hints, never ground truth
    expect(prompt).toContain('hint');
    expect(prompt).toContain('不带 markdown 代码块包裹');
  });

  it('builds a wenyan SolutionGenerateTask prompt with prose-appropriate signals', () => {
    const prompt = getTaskSystemPrompt('SolutionGenerateTask');
    expect(prompt).toContain('expected_signals');
    expect(prompt).toContain('worked_solution_md');
  });

  it('builds a QuizGenTask prompt that enforces the §0 self-declared-sources contract', () => {
    const wenyan = getTaskSystemPrompt('QuizGenTask');
    const math = getTaskSystemPrompt('QuizGenTask', resolveSubjectProfile('math'));

    // Subject voice flows in via displayName.
    expect(wenyan).toContain('文言文');
    expect(math).toContain('数学');

    for (const prompt of [wenyan, math]) {
      // §1 — search for SOURCE MATERIAL, not questions.
      expect(prompt).toContain('素材');
      expect(prompt).toContain('原创');
      // §0 — every used URL must be self-declared into source_refs.
      expect(prompt).toContain('source_refs');
      expect(prompt).toContain('used_for');
      expect(prompt).toContain('无法');
      // §2 — output shape + self copy_safety.
      expect(prompt).toContain('QuizGenOutput');
      expect(prompt).toContain('source_pack');
      expect(prompt).toContain('self_copy_safety');
      expect(prompt).toContain('agent_self');
      expect(prompt).toContain('generation_method');
      // Tools referenced by capability (handler resolves names at run time).
      expect(prompt).toContain('tavily_search');
      expect(prompt).toContain('tavily_extract');
      // canonical kinds, no subject-only leakage.
      expect(prompt).toMatch(/\bchoice\b/);
      expect(prompt).not.toMatch(/\bsingle_choice\b/);
      expect(prompt).not.toMatch(/\bword_problem\b/);
    }
  });

  it('builds a QuizVerifyTask prompt with the three §5 checks + two-axis output', () => {
    const wenyan = getTaskSystemPrompt('QuizVerifyTask');
    const math = getTaskSystemPrompt('QuizVerifyTask', resolveSubjectProfile('math'));

    // Subject voice flows in via displayName.
    expect(wenyan).toContain('文言文');
    expect(math).toContain('数学');

    for (const prompt of [wenyan, math]) {
      // §5 — three checks: fact/grounding vs source_refs, plagiarism/copy_safety,
      // knowledge-hit.
      expect(prompt).toContain('source_refs');
      expect(prompt).toContain('grounding');
      expect(prompt).toContain('copy_safety');
      expect(prompt).toContain('knowledge_hit');
      // §0 — verifier trusts the agent's self-reported source_refs (closed-book).
      expect(prompt).toContain('closed-book');
      // two-axis output shape name.
      expect(prompt).toContain('QuizVerificationResult');
      // per-check verdict + overall verdict.
      expect(prompt).toContain('overall');
      // copy_safety verdict vocabulary.
      expect(prompt).toContain('too_close');
      expect(prompt).toContain('max_overlap');
      // strict JSON, no leakage.
      expect(prompt).not.toMatch(/\bsingle_choice\b/);
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
    for (const kind of [
      'VisionExtractTask',
      'VisionExtractTaskHeavy',
      'ReviewIntentTask',
    ] as const) {
      const w = getTaskSystemPrompt(kind, wenyanProfile);
      const m = getTaskSystemPrompt(kind, mathProfile);
      expect(w, `${kind} profile-coupling regression`).toBe(m);
      expect(w).toBe(tasks[kind].systemPrompt);
    }
  });
});

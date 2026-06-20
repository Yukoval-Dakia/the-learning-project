import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { tasks } from './registry';
import { getTaskSystemPrompt } from './task-prompts';

describe('getTaskSystemPrompt', () => {
  // YUK (wenyan deprotagonist): the DEFAULT profile is now the neutral `general`
  // (was wenyan), so the default NoteGenerateTask prompt carries the general
  // role + voice, NOT wenyan's classical-Chinese fragments.
  it('defaults to the neutral general NoteGenerateTask prompt', () => {
    const prompt = getTaskSystemPrompt('NoteGenerateTask');

    expect(prompt).toContain('你是通用学习笔记作者');
    expect(prompt).toContain('artifact_type');
    expect(prompt).toContain('body_blocks');
    expect(prompt).toContain('note_atomic');
    expect(prompt).toContain('note_long');
    expect(prompt).toContain('note_hub');
    // general voice, not wenyan's 原文短句 special-casing
    expect(prompt).toContain('示例贴合知识点');
    expect(prompt).toContain('材料不足时标注不确定');
    expect(prompt).not.toContain('古文');
  });

  // wenyan is one filled-in sample subject — its prompt is preserved when the
  // wenyan profile is resolved explicitly (no longer the implicit default).
  it('builds the wenyan NoteGenerateTask prompt when wenyan is resolved', () => {
    const prompt = getTaskSystemPrompt('NoteGenerateTask', resolveSubjectProfile('wenyan'));

    expect(prompt).toContain('你是文言文学习笔记作者');
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

  // YUK-228 (S3 Slice B) — plan test matrix row: 「prompt 删薄不破契约」.
  // Verifies that after the Note skill migration slim-down, each buildNoteXxxPrompt
  // still contains (a) I/O JSON shape, (b) noteTemplate injection (per-subject data),
  // (c) fallback semantics sufficient for the degraded (no-skill) path.
  it('NoteGenerateTask slim: I/O shape + noteTemplate + fallback semantics intact', () => {
    const wenyan = getTaskSystemPrompt('NoteGenerateTask', resolveSubjectProfile('wenyan'));
    const math = getTaskSystemPrompt('NoteGenerateTask', resolveSubjectProfile('math'));

    for (const prompt of [wenyan, math]) {
      // I/O contract
      expect(prompt).toContain('artifact_id');
      expect(prompt).toContain('artifact_type');
      expect(prompt).toContain('body_blocks');
      expect(prompt).toContain('note_atomic');
      expect(prompt).toContain('note_long');
      expect(prompt).toContain('note_hub');
      // attrs contract
      expect(prompt).toContain('source_tier="llm_only"');
      expect(prompt).toContain('user_verified=false');
      expect(prompt).toContain('semantic_kind');
      // fallback: all five semantic_kind names present
      expect(prompt).toContain('definition');
      expect(prompt).toContain('mechanism');
      expect(prompt).toContain('example');
      expect(prompt).toContain('pitfall');
      expect(prompt).toContain('check');
    }
    // noteTemplate injection (per-subject data, not in SKILL.md)
    expect(wenyan).toContain('引用短句并标明关键字词'); // wenyan example template
    expect(math).toContain('带步骤的短例题'); // math example template
  });

  it('NoteVerifyTask slim: I/O shape + four-dim fallback + verdicts intact', () => {
    const math = getTaskSystemPrompt('NoteVerifyTask', resolveSubjectProfile('math'));

    // I/O contract
    expect(math).toContain('NoteVerificationResult');
    expect(math).toContain('artifact_id');
    expect(math).toContain('body_blocks');
    expect(math).toContain('block_summaries');
    expect(math).toContain('"verdict":"pass"|"needs_review"');
    expect(math).toContain('"severity":"info"|"warn"|"error"');
    // format rule
    expect(math).toContain('block_id');
    expect(math).toContain('attrs.id');
    // fallback four-dim (compressed but all four present)
    expect(math).toContain('factuality');
    expect(math).toContain('coverage');
    expect(math).toContain('clarity');
    expect(math).toContain('subject_fit');
    // fallback coverage: five semantic_kinds listed
    expect(math).toContain('definition/mechanism/example/pitfall/check');
    // fallback verdict thresholds
    expect(math).toContain('pass');
    expect(math).toContain('needs_review');
    expect(math).toContain('confidence<0.6');
    // per-subject grounding injected
    expect(math).toContain('条件不足时指出缺少的条件');
  });

  it('NoteRefineTask slim: NotePatchOp union + ADR-0020 constraint intact', () => {
    const prompt = getTaskSystemPrompt('NoteRefineTask');

    // I/O contract
    expect(prompt).toContain('NotePatch');
    expect(prompt).toContain('ops');
    // four op kinds
    expect(prompt).toContain('insert_after');
    expect(prompt).toContain('replace_block');
    expect(prompt).toContain('delete_block');
    expect(prompt).toContain('append_block');
    // ADR-0020 block_id stability constraint
    expect(prompt).toContain('ADR-0020');
    expect(prompt).toContain('target_block_id');
    // mutator threshold hint
    expect(prompt).toContain('≤ 3');
    // semantic_kind boundary preserved
    expect(prompt).toContain('definition / mechanism / example / pitfall / check');
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
    const wenyan = getTaskSystemPrompt('TeachingTurnTask', resolveSubjectProfile('wenyan'));
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

  // YUK-358 决定3：EmbeddedCheckGenerateTask prompt 测试已删（内嵌判分自测孤儿链真删）。

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
    const prompt = getTaskSystemPrompt('SolutionGenerateTask', resolveSubjectProfile('wenyan'));
    expect(prompt).toContain('expected_signals');
    expect(prompt).toContain('worked_solution_md');
  });

  it('builds a QuizGenTask prompt that enforces the §0 self-declared-sources contract', () => {
    const wenyan = getTaskSystemPrompt('QuizGenTask', resolveSubjectProfile('wenyan'));
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

  // ADR-0031 / YUK-304 (lane B) — the QuizIntentParseTask prompt test is deleted
  // with the task (C-form retired); QuestionAuthorTask below is its replacement
  // generation-side coverage.

  it('builds a QuestionAuthorTask prompt with the one-question + structured-tree contract', () => {
    const wenyan = getTaskSystemPrompt('QuestionAuthorTask', resolveSubjectProfile('wenyan'));
    const math = getTaskSystemPrompt('QuestionAuthorTask', resolveSubjectProfile('math'));

    // Subject voice flows in via displayName.
    expect(wenyan).toContain('文言文');
    expect(math).toContain('数学');

    for (const prompt of [wenyan, math]) {
      // Output shape name + the Axis-A tree contract (stem+sub vs standalone).
      expect(prompt).toContain('QuestionAuthorDraft');
      expect(prompt).toContain('structured');
      expect(prompt).toContain('sub_questions');
      expect(prompt).toContain('standalone');
      expect(prompt).toContain('stem');
      // Closed-set knowledge ids (knowledge_context) — never invent.
      expect(prompt).toContain('knowledge_context');
      expect(prompt).toContain('knowledge_ids');
      expect(prompt).toContain('禁止发明');
      // material seed: the pasted body is the grounding anchor.
      expect(prompt).toContain('material');
      expect(prompt).toContain('body_md');
      // Exactly ONE question per call (决定6: copilot orchestrates, not the task).
      expect(prompt).toContain('一道');
      // canonical kinds, no subject-only leakage.
      expect(prompt).toMatch(/\bchoice\b/);
      expect(prompt).not.toMatch(/\bsingle_choice\b/);
      expect(prompt).not.toMatch(/\bword_problem\b/);
    }
  });

  it('builds a QuizVerifyTask prompt with the three §5 checks + two-axis output', () => {
    const wenyan = getTaskSystemPrompt('QuizVerifyTask', resolveSubjectProfile('wenyan'));
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

  // YUK-361 Phase 3 Step B (Task 8 L2, ADR-0042 编排档2) — pin the orchestrator
  // contract: per-candidate weight output, the no-due-items 铁律, and the bucketed
  // (NOT raw-float) signal framing (ADR-0042:68 signal-fidelity mitigation).
  it('builds a SelectionOrchestratorTask prompt with per-candidate weight + bucketed-signal + no-due contract', () => {
    const wenyan = getTaskSystemPrompt(
      'SelectionOrchestratorTask',
      resolveSubjectProfile('wenyan'),
    );
    const math = getTaskSystemPrompt('SelectionOrchestratorTask', resolveSubjectProfile('math'));

    // Subject voice flows in via displayName.
    expect(wenyan).toContain('文言文');
    expect(math).toContain('数学');

    for (const prompt of [wenyan, math]) {
      // Per-candidate weight is the 档2 core output.
      expect(prompt).toContain('weight');
      expect(prompt).toContain('arrangement');
      expect(prompt).toContain('reason');
      // Output shape name (pins StructuredOutput / brace-slice both reading it).
      expect(prompt).toContain('SelectionOrchestratorDraft');
      // The four non-due roles (NO 'due' — LLM must not touch due items).
      expect(prompt).toContain('frontier');
      expect(prompt).toContain('diagnostic');
      expect(prompt).toContain('new_check');
      // The no-due-items 铁律 (FSRS when contract — due relative order is L1).
      expect(prompt).toContain('到期');
      // Bucketed signals, not raw floats (signal-fidelity mitigation).
      expect(prompt).toMatch(/high|mid|low/);
      // CLUSTER E (review)：prompt must NOT claim recall candidates are in the LLM
      // input — they are stripped before buildSelectionOrchestratorInput. The
      // misleading `recall_locked=true 的候选：照常给 weight` line was removed.
      expect(prompt).not.toContain('recall_locked');
      // Instead the prompt tells the LLM it won't see recall candidates (deterministic
      // same-question passthrough — never weighted/sampled).
      expect(prompt).toContain('原题重背');
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

  // YUK-227 S3 Slice C (FIX-1) — the SourcingTask prompt MUST teach the agent the
  // image_candidate contract, otherwise the new accept path is unreachable in
  // production (the agent never emits image_candidates). These pins are the prompt
  // half of the contract; sourcing.ts:490 consumes parsed.image_candidates.
  describe('SourcingTask prompt — image_candidate contract (FIX-1)', () => {
    it('documents the image_candidates output array + its three fields', () => {
      const prompt = getTaskSystemPrompt('SourcingTask');
      // The whole-run output contract lists image_candidates (so an agent that
      // reads the contract knows the key exists).
      expect(prompt).toContain('image_candidates');
      expect(prompt).toContain('SourcingImageCandidate');
      // The per-candidate shape names all three schema fields (sourcing.ts:79-88).
      expect(prompt).toContain('source_url');
      expect(prompt).toContain('source_title');
      expect(prompt).toContain('summary_md');
    });

    it('teaches WHEN to report an image_candidate (tavily_extract empty + search says questions)', () => {
      const prompt = getTaskSystemPrompt('SourcingTask');
      expect(prompt).toContain('tavily_extract');
      // The trigger condition: stem lives in an image / cannot lift as text.
      expect(prompt).toMatch(/图片/);
      // 守 ADR-0002: VLM 抽图是用户 accept 后的付费动作, NOT the agent's job.
      expect(prompt).toContain('accept');
    });

    it('forbids double-reporting a source as both a question and a candidate', () => {
      const prompt = getTaskSystemPrompt('SourcingTask');
      expect(prompt).toContain('二选一');
      // The stale "skip all image sources" instruction is gone (the agent must now
      // surface them, not silently drop them).
      expect(prompt).not.toContain('跳过纯图片型题源');
      expect(prompt).not.toContain('跳过纯图片题源');
    });

    it('keeps the image_candidate contract for a non-default (math) subject', () => {
      const prompt = getTaskSystemPrompt('SourcingTask', resolveSubjectProfile('math'));
      expect(prompt).toContain('image_candidates');
      expect(prompt).toContain('summary_md');
    });
  });
});

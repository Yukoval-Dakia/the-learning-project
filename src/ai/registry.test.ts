// Phase 1c.1 Step 7 — registry sanity test.
//
// Pins task system prompts to the event-stream framing introduced in Steps 7.A
// / 7.B / 7.D. Accidental prompt regressions (e.g., reverting to legacy
// "做错的题" / "mistake" entity terminology, or dropping the new
// propose_knowledge_edge mutation option) surface as unit-test failures here
// rather than as silent drift in production LLM behaviour.
//
// Assertions are coarse substring matches — full-regex pins are brittle against
// reasonable copy edits. The risk this catches is "someone reverted the spec",
// not "wording was tweaked".

import { createHash } from 'node:crypto';
import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import promptHashOracle from './fixtures/task-prompt-hashes.4cb5b966.json' with { type: 'json' };
import { type TaskDef, tasks } from './registry';
import { getTaskSystemPrompt } from './task-prompts';

describe('copilot task dispatch declarations', () => {
  it('is deny-by-default and exposes exactly two fully-declared tasks', () => {
    const invocable = Object.values(tasks).filter(
      (task) => 'copilot' in task && task.copilot?.invocable === true,
    );
    expect(invocable.map((task) => task.kind).sort()).toEqual([
      'GoalScopeTask',
      'QuestionAuthorTask',
    ]);
    for (const task of invocable) {
      if (!('copilot' in task) || !task.copilot) throw new Error(task.kind);
      expect(task.copilot.intentSchema.safeParse).toBeTypeOf('function');
      expect(task.copilot.prepare).toBeTypeOf('function');
    }
    expect(Object.keys(tasks)).toHaveLength(48);
  });
});

describe('task prompt definitions', () => {
  it('defines one non-empty inline or profile prompt for every task', () => {
    expect(Object.keys(tasks)).toHaveLength(48);

    for (const task of Object.values(tasks)) {
      switch (task.prompt.kind) {
        case 'inline':
          expect(task.prompt.text.trim(), task.kind).not.toBe('');
          break;
        case 'profile':
          expect(task.prompt.build, task.kind).toBeTypeOf('function');
          break;
        default: {
          const unhandled: never = task.prompt;
          throw new Error(`Unhandled prompt kind: ${JSON.stringify(unhandled)}`);
        }
      }
    }
  });

  it('resolves every task without sentinel or duplicate fallback storage', () => {
    for (const [kind, task] of Object.entries(tasks)) {
      const resolved = getTaskSystemPrompt(kind as keyof typeof tasks);
      expect(resolved.trim(), kind).not.toBe('');
      expect(resolved, kind).not.toContain('see getTaskSystemPrompt');
      expect(Object.hasOwn(task, 'systemPrompt'), kind).toBe(false);
    }
  });

  it('matches every unchanged prompt byte-for-byte with the exact pre-refactor oracle', () => {
    expect(promptHashOracle.baseCommit).toBe('4cb5b9669e9343f5bf4a21385626edc5ed9ad257');
    expect(promptHashOracle.algorithm).toBe('sha256');
    expect(promptHashOracle.taskCount).toBe(43);
    expect(Object.keys(promptHashOracle.prompts)).toHaveLength(129);

    for (const profileId of promptHashOracle.profiles) {
      const profile = resolveSubjectProfile(profileId);
      for (const task of Object.keys(tasks) as Array<keyof typeof tasks>) {
        // YUK-821 intentionally replaces the induction/grouping contracts, adds the
        // author/reviewer tasks, and updates the director charter. YUK-827 extends the
        // existing single-call judge with response-signature classification. Dedicated
        // tests below pin those behaviors; the old oracle still guards unchanged prompts.
        if (
          task === 'MindModelInductionTask' ||
          task === 'ConjectureGroupingTask' ||
          task === 'ConjectureProbeAuthorTask' ||
          task === 'ConjectureProbeReviewTask' ||
          task === 'ResearchMeetingDirectorTask' ||
          task === 'MultimodalDirectJudgeTask' ||
          task === 'InterventionRecommendationTask' ||
          task === 'InterventionPackageAuthorTask' ||
          task === 'InterventionPackageReviewTask' ||
          task === 'SolutionGenerateTask' ||
          task === 'SolutionGenerateVisionTask' ||
          task === 'SelectionOrchestratorTask'
        ) {
          continue;
        }
        const key = `${profileId}:${task}` as keyof typeof promptHashOracle.prompts;
        const actualHash = createHash('sha256')
          .update(getTaskSystemPrompt(task, profile), 'utf8')
          .digest('hex');
        expect(actualHash, key).toBe(promptHashOracle.prompts[key]);
      }
    }
  });

  it('pins the live-reader-only selection orchestrator prompt for every profile', () => {
    const expected = {
      general: '4ccfb385fdd9156c84a0345db8582a1ad7ff0b9c8ef6e124d24b022e72d97f25',
      math: '2dcc510d7748f3f43c6cf8b209be54c8fc2a0bd1e33178310b9b3ef598aca975',
      physics: '1d0b5f01465d9f85c6f7cdc660a7bed9f974102d4d95a2ba9cda0641d365faa4',
      yuwen: 'd4383ab72c547dfec9da94f2b5221d5ff443261170ab892fd4ecb18491bfd0e1',
    } as const;
    for (const profileId of ['general', 'math', 'physics', 'yuwen'] as const) {
      const prompt = getTaskSystemPrompt(
        'SelectionOrchestratorTask',
        resolveSubjectProfile(profileId),
      );
      expect(prompt).not.toContain('transfer_gap');
      expect(createHash('sha256').update(prompt, 'utf8').digest('hex')).toBe(expected[profileId]);
    }
  });

  it('pins the response-aware conjecture probe author/reviewer prompts for every profile', () => {
    const expected = {
      'general:ConjectureProbeAuthorTask':
        '1337f632a207767ad1408723f07d9cc9281220828074ba2dc2c6f65da6d87969',
      'general:ConjectureProbeReviewTask':
        '887a6442092af1cc1882a21942e50a671c249b179e7f931bfac9b4e61dc0552a',
      'math:ConjectureProbeAuthorTask':
        'bc9ad647833de7e13227a98a7776f76c78c5c3964e88b0ba128202ad555bf6b2',
      'math:ConjectureProbeReviewTask':
        'bb1c6d7a01ad9ef31ae5e5a5c5784436aa1eb495e3328d0840c0f31539ef8fed',
      'physics:ConjectureProbeAuthorTask':
        '44ceec14112bf53e0e197b3e9be813c57d4f056a1c909900c772061a3f9f5694',
      'physics:ConjectureProbeReviewTask':
        '3d81bdeac649bd8331f958dc2fb429851f19e49cfffb9316b3a22e0dfe1aacd0',
      'yuwen:ConjectureProbeAuthorTask':
        '5c890570f0dbca25f1661556a4dabecaa0161223643d467b9f6ce6c7931c7d5f',
      'yuwen:ConjectureProbeReviewTask':
        '0c24bae37112cdbbd90d65929f11909501ca1747027118008d6db098f34e3d86',
    } as const;
    for (const profileId of ['general', 'math', 'physics', 'yuwen'] as const) {
      const profile = resolveSubjectProfile(profileId);
      for (const task of ['ConjectureProbeAuthorTask', 'ConjectureProbeReviewTask'] as const) {
        const key = `${profileId}:${task}` as keyof typeof expected;
        const actualHash = createHash('sha256')
          .update(getTaskSystemPrompt(task, profile), 'utf8')
          .digest('hex');
        expect(actualHash, key).toBe(expected[key]);
      }
    }
  });

  it('pins the response-aware intervention preparation prompts for every profile', () => {
    const expected = {
      'general:InterventionRecommendationTask':
        'a45614f87725a2290f5b2442a3104e761d10f5b5ec76e1ce27fd979b2ee41ecd',
      'general:InterventionPackageAuthorTask':
        '60c55bb06557f2815b7ffe7d5835dd8a5561cbe8a23849a596eb45692c73146e',
      'general:InterventionPackageReviewTask':
        '75941f02812960b9c09b55e3e33f2710bf98ca69dc2de35de4d705f8b7ba9ba3',
      'math:InterventionRecommendationTask':
        'a45614f87725a2290f5b2442a3104e761d10f5b5ec76e1ce27fd979b2ee41ecd',
      'math:InterventionPackageAuthorTask':
        '5748f5259952696212c4504f5a97953ecaa3415c573245d02c499bde99806bc7',
      'math:InterventionPackageReviewTask':
        '7d1ab3d888856c098162c75a48d1274c8a109a9dc623ba6e497d634c6f34fe8f',
      'physics:InterventionRecommendationTask':
        'a45614f87725a2290f5b2442a3104e761d10f5b5ec76e1ce27fd979b2ee41ecd',
      'physics:InterventionPackageAuthorTask':
        '5f85c39d955878b0c293f07fd271ce6ff8509f9a9b8fe19045aea4696f956cdb',
      'physics:InterventionPackageReviewTask':
        '1532772eb23553180e710d34703b2d7abac5984d8302823358e71e66598c2e28',
      'yuwen:InterventionRecommendationTask':
        'a45614f87725a2290f5b2442a3104e761d10f5b5ec76e1ce27fd979b2ee41ecd',
      'yuwen:InterventionPackageAuthorTask':
        'c46426ca2c07e712a5e90d6b6962d377df7aff4955cc036c200eac62ea08ce02',
      'yuwen:InterventionPackageReviewTask':
        '4ec8a859aad509e936ce3f4764dba462beb9f77893c255b9d4758f833cd34fe9',
    } as const;
    for (const profileId of ['general', 'math', 'physics', 'yuwen'] as const) {
      const profile = resolveSubjectProfile(profileId);
      for (const task of [
        'InterventionRecommendationTask',
        'InterventionPackageAuthorTask',
        'InterventionPackageReviewTask',
      ] as const) {
        const key = `${profileId}:${task}` as keyof typeof expected;
        const actualHash = createHash('sha256')
          .update(getTaskSystemPrompt(task, profile), 'utf8')
          .digest('hex');
        expect(actualHash, key).toBe(expected[key]);
      }
    }
  });

  it('pins the shared solver complete-path contract for every profile', () => {
    const expected = {
      'general:SolutionGenerateTask':
        'da24cd782c7457d4f0c24fac9532416b03742e32e488a8219bf51679aa62b3e4',
      'general:SolutionGenerateVisionTask':
        'ff525b259a3c289b4f503ac3abea536d913c417495dfb797d8fd0da2fbffea12',
      'math:SolutionGenerateTask':
        '8633a43ebad6faecaa5ab43c7a07b3a2dc781325b1c49ae5d879edd2a12e2934',
      'math:SolutionGenerateVisionTask':
        '58b399397a3beb2170ee6b2734b66024e493c4f9024f8832bd3065b095c63ada',
      'physics:SolutionGenerateTask':
        'a83c64d31a97cf996720f2acd62be761fe0b179403e23ba62e945dbb11de80af',
      'physics:SolutionGenerateVisionTask':
        'cdfe1ea118e0376354d7810e10007c1d64eb53b5b5503481b747cff194b18cf5',
      'yuwen:SolutionGenerateTask':
        '8725987c7b9039b6fa49fbd12a31a4eff40cbe0e098fe0e0c748724ed6dc8be8',
      'yuwen:SolutionGenerateVisionTask':
        '8701d02b69cc5d07b0384709bac4684a5125812fc405cd59b377abf8b71b8bf8',
    } as const;
    for (const profileId of ['general', 'math', 'physics', 'yuwen'] as const) {
      for (const task of ['SolutionGenerateTask', 'SolutionGenerateVisionTask'] as const) {
        const prompt = getTaskSystemPrompt(task, resolveSubjectProfile(profileId));
        expect(prompt).toContain('完整必要解题路径');
        expect(prompt).toContain('1..12');
        expect(prompt).toContain('outcome construct / estimand Y');
        expect(prompt).toContain('同一 outcome construct 的先行状态或倾向');
        expect(prompt).toContain('即使机制表现为 self-selection 或按病情分配');
        expect(createHash('sha256').update(prompt, 'utf8').digest('hex')).toBe(
          expected[`${profileId}:${task}`],
        );
      }
    }
  });

  it('requires the intervention comparator to consume sealed validator outputs and enforce frozen scope', () => {
    const prompt = getTaskSystemPrompt(
      'InterventionPackageReviewTask',
      resolveSubjectProfile('math'),
    );

    expect(prompt).toContain('sealed_independent_solutions');
    expect(prompt).toContain('现有题目 validator');
    expect(prompt).toContain('不得改写、替换或伪造密封结果');
    expect(prompt).toContain('服务端按 kind 绑定对应密封 solver digest');
    expect(prompt).toContain('required_operation_checks');
    expect(prompt).toContain('不得输出或猜测 operation_sha256');
    expect(prompt).toContain('package_checks');
    expect(prompt).toContain('scope_boundary_md');
    expect(prompt).toContain('完整必要解题路径');
    expect(prompt).toContain('all-of');
    expect(prompt).toContain('review_requirements.audit_entire_solution_path=true');
    expect(prompt).toContain('reference_incorrect');
    expect(prompt).toContain('claim_scope_expansion');
    expect(prompt).toContain('Y0');
    expect(prompt).toContain('reverse causation');
    expect(prompt).toContain('causal_direction_check');
    expect(prompt).toContain('review_requirements.causal_direction_required=true');
    expect(prompt).toContain('baseline_or_prior_different_construct');
    expect(prompt).toContain('same_outcome_construct_y');
    expect(prompt).toContain('只要驱动 X 的就是同一 Y construct');
    expect(prompt).toContain('claimed_cause_is_observed_y_causing_x 由服务端');
    expect(prompt).toContain('每种 kind 恰好一次');
    expect(prompt).not.toContain('先遮蔽 reference_md');
    expect(prompt).not.toContain('卜算子·咏梅');
  });

  it('keeps inline prompts profile-independent', () => {
    for (const [kind, task] of Object.entries(tasks)) {
      if (task.prompt.kind !== 'inline') continue;
      const taskKind = kind as keyof typeof tasks;
      expect(getTaskSystemPrompt(taskKind, resolveSubjectProfile('math')), kind).toBe(
        getTaskSystemPrompt(taskKind, resolveSubjectProfile('yuwen')),
      );
    }
  });
});

describe('AttributionTask.systemPrompt', () => {
  it('emits Lane B field name analysis_md (not legacy ai_analysis_md)', () => {
    const p = getTaskSystemPrompt('AttributionTask');
    expect(p).toContain('analysis_md');
    expect(p).not.toContain('ai_analysis_md');
  });

  it('frames input as attempt event with judge event downstream', () => {
    const p = getTaskSystemPrompt('AttributionTask');
    expect(p).toContain('attempt event');
    expect(p).toContain('judge event');
    expect(p).toContain('caused_by_event_id');
  });

  // Codex P1-D — input fields must match AttributionInput (prompt_md,
  // reference_md, wrong_answer_md, knowledge_context). Prompt previously
  // referenced `event.payload.answer_md`, which doesn't match what runtime
  // actually sends, leaving the LLM guessing.
  it('references the flat AttributionInput field names (wrong_answer_md, not payload.answer_md)', () => {
    const p = getTaskSystemPrompt('AttributionTask');
    expect(p).toContain('wrong_answer_md');
    expect(p).not.toContain('payload.answer_md');
    expect(p).not.toContain('event.payload.answer_md');
  });
});

// Lane D (YUK-482): KnowledgeProposeTask.systemPrompt assertions removed — the
// task was deleted (answer-wrong → propose-new-KC coupling unwired).

describe('KnowledgeReviewTask.systemPrompt', () => {
  it('mentions attempt events + propose_knowledge_edge + relation_type', () => {
    const p = getTaskSystemPrompt('KnowledgeReviewTask');
    expect(p).toContain('attempt event');
    expect(p).toContain('propose_knowledge_edge');
    expect(p).toContain('relation_type');
  });

  it('keeps tree-shape mutations enumerated', () => {
    const p = getTaskSystemPrompt('KnowledgeReviewTask');
    expect(p).toContain('propose_new');
    expect(p).toContain('reparent');
    expect(p).toContain('merge');
    expect(p).toContain('split');
    expect(p).toContain('archive');
  });

  it('lists the 5 core relation_type enums', () => {
    const p = getTaskSystemPrompt('KnowledgeReviewTask');
    for (const r of [
      'prerequisite',
      'related_to',
      'contrasts_with',
      'applied_in',
      'derived_from',
    ]) {
      expect(p).toContain(r);
    }
  });
});

describe('Vision tasks (unchanged in Step 7)', () => {
  it('VisionExtractTask + VisionExtractTaskHeavy remain manual_rescue_only', () => {
    expect(tasks.VisionExtractTask.invocation).toBe('manual_rescue_only');
    expect(tasks.VisionExtractTaskHeavy.invocation).toBe('manual_rescue_only');
  });
});

describe('UnitDimensionFallback registry entry', () => {
  it('is registered so runTask can execute the unit_dimension fallback path', () => {
    expect(tasks.UnitDimensionFallback.kind).toBe('UnitDimensionFallback');
    expect(tasks.UnitDimensionFallback.needsToolCall).toBe(false);
    expect(tasks.UnitDimensionFallback.isMultimodal).toBe(false);
    expect(tasks.UnitDimensionFallback.allowedTools).toEqual([]);
    expect(getTaskSystemPrompt('UnitDimensionFallback')).toContain('量纲');
  });
});

describe('MultimodalDirectJudgeTask registry entry', () => {
  it('is a single-call multimodal vision task with room for outputFormat finalization (YUK-201/YUK-792)', () => {
    expect(tasks.MultimodalDirectJudgeTask.kind).toBe('MultimodalDirectJudgeTask');
    expect(tasks.MultimodalDirectJudgeTask.defaultProvider).toBe('xiaomi');
    expect(tasks.MultimodalDirectJudgeTask.defaultModel).toBe('mimo-v2.5');
    expect(tasks.MultimodalDirectJudgeTask.isMultimodal).toBe(true);
    expect(tasks.MultimodalDirectJudgeTask.needsToolCall).toBe(false);
    expect(tasks.MultimodalDirectJudgeTask.allowedTools).toEqual([]);
    expect(tasks.MultimodalDirectJudgeTask.budget.maxIterations).toBe(2);
    expect(tasks.MultimodalDirectJudgeTask.budget.timeout).toBe(90_000);
    // invocation defaults to 'auto' (graded via the multimodal_direct route, not a
    // manual rescue). The entry omits the optional field.
    expect((tasks.MultimodalDirectJudgeTask as TaskDef).invocation).toBeUndefined();
  });

  it('separates semantic target-error matching from ordinary correctness', () => {
    const prompt = getTaskSystemPrompt('MultimodalDirectJudgeTask');
    expect(prompt).toContain('probe_response_contract');
    expect(prompt).toContain('ordinary wrong');
    expect(prompt).toContain('target_error');
    expect(prompt).toContain('ambiguous');
  });
});

describe('SolutionGenerateTask registry entry', () => {
  it('is registered as a single-shot text task usable by runTask', () => {
    expect(tasks.SolutionGenerateTask.kind).toBe('SolutionGenerateTask');
    expect(tasks.SolutionGenerateTask.needsToolCall).toBe(false);
    expect(tasks.SolutionGenerateTask.isMultimodal).toBe(false);
    expect(tasks.SolutionGenerateTask.allowedTools).toEqual([]);
    expect(tasks.SolutionGenerateTask.budget.maxIterations).toBe(1);
    // invocation defaults to 'auto' (called from the solve orchestrator, not a
    // manual rescue). The entry omits the optional `invocation` field, so the
    // satisfies-inferred literal type for this key drops the property; read it
    // through the TaskDef view to assert the runtime value is undefined.
    expect((tasks.SolutionGenerateTask as TaskDef).invocation).toBeUndefined();
  });
});

describe('SolutionGenerateVisionTask registry entry', () => {
  it('uses the vision-capable mimo route with the same single-shot shape', () => {
    expect(tasks.SolutionGenerateVisionTask.kind).toBe('SolutionGenerateVisionTask');
    expect(tasks.SolutionGenerateVisionTask.defaultProvider).toBe('xiaomi');
    expect(tasks.SolutionGenerateVisionTask.defaultModel).toBe('mimo-v2.5');
    expect(tasks.SolutionGenerateVisionTask.isMultimodal).toBe(true);
    expect(tasks.SolutionGenerateVisionTask.needsToolCall).toBe(false);
    expect(tasks.SolutionGenerateVisionTask.budget.maxIterations).toBe(1);
  });
});

describe('QuizGenTask registry entry', () => {
  // Search-grounded QuizGen wave (T-SQ) §1 — agentic tool-calling task. Budget
  // and tool-call flags are part of the slice contract: maxIterations 8,
  // timeout 120s, needsToolCall true, allowedTools [] (the handler injects the
  // Tavily + domain MCP allowlist at run time).
  it('is registered as a tool-calling agent task', () => {
    expect(tasks.QuizGenTask.kind).toBe('QuizGenTask');
    expect(tasks.QuizGenTask.needsToolCall).toBe(true);
    expect(tasks.QuizGenTask.isMultimodal).toBe(false);
    expect(tasks.QuizGenTask.allowedTools).toEqual([]);
    expect(tasks.QuizGenTask.budget.maxIterations).toBe(8);
    expect(tasks.QuizGenTask.budget.timeout).toBe(120_000);
  });

  it('uses the mimo-v2.5-pro default (fallbackChain deleted per YUK-576)', () => {
    expect(tasks.QuizGenTask.defaultProvider).toBe('xiaomi');
    expect(tasks.QuizGenTask.defaultModel).toBe('mimo-v2.5-pro');
  });
});

describe('QuizVerifyTask registry entry', () => {
  // Search-grounded QuizGen wave (T-SQ) §1 / §5 Q5 — single-shot, closed-book
  // verifier built on the VariantVerify skeleton: needsToolCall false,
  // maxIterations 1, timeout 60s, allowedTools [] (it trusts the agent's
  // self-reported source_refs; no own Tavily loop this wave).
  it('is registered as a single-shot closed-book verifier', () => {
    expect(tasks.QuizVerifyTask.kind).toBe('QuizVerifyTask');
    expect(tasks.QuizVerifyTask.needsToolCall).toBe(false);
    expect(tasks.QuizVerifyTask.isMultimodal).toBe(false);
    expect(tasks.QuizVerifyTask.allowedTools).toEqual([]);
    expect(tasks.QuizVerifyTask.budget.maxIterations).toBe(1);
    expect(tasks.QuizVerifyTask.budget.timeout).toBe(60_000);
  });

  it('uses the mimo-v2.5-pro default (fallbackChain deleted per YUK-576)', () => {
    expect(tasks.QuizVerifyTask.defaultProvider).toBe('xiaomi');
    expect(tasks.QuizVerifyTask.defaultModel).toBe('mimo-v2.5-pro');
  });
});

// ADR-0031 / YUK-304 (lane B) — the QuizIntentParseTask describe is deleted with
// the task itself (the YUK-275 C-form free-text 求卷 parser is retired).

describe('QuestionAuthorTask registry entry', () => {
  // ADR-0031 / YUK-304 (quiz C→A lane B) — single-shot draft-question author,
  // registered 照 GoalScopeTask 范式. 决定6 contract pins: maxIterations 1 (NOT
  // the QuizGenTask 8-iteration agent budget), needsToolCall false, allowedTools
  // [] (no Tavily, no domain tools — the copilot orchestrates).
  it('is registered as a single-shot structured author usable by runTask', () => {
    expect(tasks.QuestionAuthorTask.kind).toBe('QuestionAuthorTask');
    expect(tasks.QuestionAuthorTask.needsToolCall).toBe(false);
    expect(tasks.QuestionAuthorTask.isMultimodal).toBe(false);
    expect(tasks.QuestionAuthorTask.allowedTools).toEqual([]);
    expect(tasks.QuestionAuthorTask.budget.maxIterations).toBe(1);
    expect(tasks.QuestionAuthorTask.budget.timeout).toBe(90_000);
    // invocation defaults to 'auto' (called from the author_question DomainTool,
    // not a manual rescue); the entry omits the optional field.
    expect((tasks.QuestionAuthorTask as TaskDef).invocation).toBeUndefined();
  });

  it('uses the mimo-v2.5-pro default (fallbackChain deleted per YUK-576)', () => {
    expect(tasks.QuestionAuthorTask.defaultProvider).toBe('xiaomi');
    expect(tasks.QuestionAuthorTask.defaultModel).toBe('mimo-v2.5-pro');
  });
});

// YUK-361 Phase 3 Step B (Task 8 L2, ADR-0042 编排档2) — the selection orchestrator
// is a single-shot structured-output composer task (NOT a tool-calling agent, NOT a
// copilotTool). Pin the contract: maxIterations 1, needsToolCall false, allowedTools
// [], runtime model = mimo-v2.5 (the registry default — must NOT route to
// sonnet/GLM, see memory: StructuredOutput incompatible).
describe('SelectionOrchestratorTask registry entry', () => {
  it('is registered as a single-shot structured composer usable by runTask', () => {
    expect(tasks.SelectionOrchestratorTask.kind).toBe('SelectionOrchestratorTask');
    expect(tasks.SelectionOrchestratorTask.needsToolCall).toBe(false);
    expect(tasks.SelectionOrchestratorTask.isMultimodal).toBe(false);
    expect(tasks.SelectionOrchestratorTask.allowedTools).toEqual([]);
    expect(tasks.SelectionOrchestratorTask.budget.maxIterations).toBe(1);
    expect(tasks.SelectionOrchestratorTask.budget.timeout).toBe(60_000);
    // invocation defaults to 'auto' (headless composer-called via the Step C shell);
    // the entry omits the optional field.
    expect((tasks.SelectionOrchestratorTask as TaskDef).invocation).toBeUndefined();
  });

  it('uses the mimo-v2.5 runtime default (NOT mimo-v2.5-pro/sonnet/GLM)', () => {
    expect(tasks.SelectionOrchestratorTask.defaultProvider).toBe('xiaomi');
    expect(tasks.SelectionOrchestratorTask.defaultModel).toBe('mimo-v2.5');
  });
});

// YUK-267 (C2) — pin the CopilotTask conversation-memory + ambient clauses so the
// history-preference prompt edit cannot silently regress.
describe('CopilotTask.systemPrompt — C2 memory + ambient clauses', () => {
  it('primes the model to prefer conversation_history over a redundant DomainTool read', () => {
    const p = getTaskSystemPrompt('CopilotTask');
    expect(p).toContain('conversation_history');
    // The history-preference instruction keyword (Chinese copy may evolve, but the
    // field name + the "prefer history / avoid redundant tool read" intent stays).
    expect(p).toMatch(/优先复用|history-preference/);
  });

  it('explains ambient_context (current route + focused_entity)', () => {
    const p = getTaskSystemPrompt('CopilotTask');
    expect(p).toContain('ambient_context');
    expect(p).toContain('focused_entity');
  });
});

// YUK-307 — pin the CopilotTask 【呈现提名】(primary_view) envelope clause. The
// chat.ts streaming tail-filter and extractPrimaryView's last-marker-wins
// semantics both depend on the marker being the reply's LAST output, so the
// 末尾/最后 placement wording is load-bearing, not copy.
describe('CopilotTask.systemPrompt — primary_view nomination clause (YUK-307)', () => {
  it('pins the marker syntax and the end-of-reply placement', () => {
    const p = getTaskSystemPrompt('CopilotTask');
    expect(p).toContain('<!--primary_view:');
    // Placement contract: end of reply, the very last output.
    expect(p).toMatch(/末尾/);
    expect(p).toMatch(/最后一个输出/);
  });

  it('pins the three ruled sources and the default-no-hero criterion', () => {
    const p = getTaskSystemPrompt('CopilotTask');
    expect(p).toContain('tool_result');
    expect(p).toContain('artifact');
    expect(p).toContain('ephemeral_html');
    // 缺省 → 无 hero（design doc §2.3 RULED）+ 纯答疑/纯过程不提名的判据句.
    expect(p).toMatch(/缺省即无 hero/);
    expect(p).toMatch(/纯答疑/);
  });

  it('pins the ephemeral_html size bound (mirrors EPHEMERAL_HTML_REF_MAX_CHARS)', () => {
    // C1 review LOW fix — over-cap ephemeral_html fails the zod parse and the
    // HTML (which lives only inside the marker) is stripped with it, so the
    // model must be told the bound up front. Literal mirrors
    // EPHEMERAL_HTML_REF_MAX_CHARS in src/capabilities/copilot/server/turns.ts (32_000);
    // change them together.
    const p = getTaskSystemPrompt('CopilotTask');
    expect(p).toMatch(/32000 字符/);
  });
});

// YUK-600（阻断②）— ColdStartPlacementBridgeTask 的 INPUT 合同从 known_subject_ids
// （字符串数组）换成 known_subjects（{id, display_name, aliases?} 对象数组）：分类依据是
// display_name/aliases，opaque id 只允许逐字回传。prompt 是这份合同唯一触达模型的面——
// invoker 的单测全部 stub runTaskFn 测不到它，所以在这里 pin 关键词（粗粒度 substring，
// 同文件头注释的口径：抓「合同被回退」，不抓措辞微调）。
describe('ColdStartPlacementBridgeTask.systemPrompt — known_subjects 对象数组合同 (YUK-600)', () => {
  it('describes the entry shape and the display_name-classify / id-verbatim split', () => {
    const p = getTaskSystemPrompt('ColdStartPlacementBridgeTask');
    expect(p).toContain('known_subjects');
    expect(p).toContain('display_name');
    expect(p).toContain('aliases');
    // Opaque-id discipline: ids are copied back verbatim, never interpreted.
    expect(p).toMatch(/verbatim/i);
    expect(p).toMatch(/opaque/i);
  });

  it('no longer references the retired known_subject_ids string-array key', () => {
    expect(getTaskSystemPrompt('ColdStartPlacementBridgeTask')).not.toContain('known_subject_ids');
  });
});

// YUK-406 Phase 0 / YUK-440 A13 — conjecture induction task registry entry.
describe('MindModelInductionTask registry entry', () => {
  it('is a multimodal bounded-output task (Opus lane chosen per-call via override, never default)', () => {
    const def: TaskDef = tasks.MindModelInductionTask;
    expect(def.kind).toBe('MindModelInductionTask');
    // anthropic-sub is opt-in via override only; it is NEVER a task default
    // (registry.ts:12-16 forbids it as defaultProvider so tests need no OAuth token).
    expect(def.defaultProvider).not.toBe('anthropic-sub');
    expect(def.needsToolCall).toBe(false);
    expect(def.isMultimodal).toBe(true);
    expect(def.allowedTools).toEqual([]);
    // YUK-800: measured grounded runs lost 10/24 samples at max-turns=1 after
    // reasoning but before JSON. With no tools, turn two can only finish output.
    expect(def.budget.maxIterations).toBe(2);
    // YUK-786: the grounded packet made this task heavier — a measured real-Opus
    // run put successful samples at 42–61s, so a 60s budget aborted a large share
    // of them mid-flight and the nightly silently dropped those cells. Do not
    // lower this back without re-measuring; grounding that never returns is not
    // grounding.
    expect(def.budget.timeout).toBeGreaterThanOrEqual(120_000);
  });

  it('requires the same top-level draft envelope as the Agent SDK output schema', () => {
    const p = getTaskSystemPrompt('MindModelInductionTask');
    expect(p).toContain('唯一字段是 draft');
    expect(p).toContain('{"draft":{"kind":"proposal"');
    expect(p).toContain('{"draft":{"kind":"abstain"');
    expect(p).toContain('不输出推理过程、markdown 或代码块');
  });

  it('exposes proposal and abstain as explicit grounded output branches', () => {
    const p = getTaskSystemPrompt('MindModelInductionTask');
    expect(p).toContain('"kind":"proposal"');
    expect(p).toContain('"kind":"abstain"');
    expect(p).toContain('evidence_event_ids');
    expect(p).toContain('insufficient_evidence');
    expect(p).toContain('禁止为了满足格式而补造');
  });

  it('freezes the target-error rule, trigger, scope, and wrong-answer signature without probes', () => {
    const p = getTaskSystemPrompt('MindModelInductionTask');
    expect(p).toContain('第二人称');
    expect(p).toContain('target_error_rule_md');
    expect(p).toContain('trigger_conditions_md');
    expect(p).toContain('scope_boundary_md');
    expect(p).toContain('expected_wrong_answer_signature_md');
    expect(p).toContain('diagnostic_spec.schema_version 恒为 2');
    expect(p).toContain('causal_direction_required');
    expect(p).toContain('导致/引起/造成');
    expect(p).toContain('本阶段**禁止出题**');
    expect(p).not.toContain('"probe_md"');
  });

  // YUK-786 — the input contract the prompt DESCRIBES must match the one
  // induceConjecture actually sends. A prompt that still advertises the old
  // 7-scalar packet would tell the model the evidence isn't there.
  it('documents the grounded input packet (KC name + subject + first-hand samples)', () => {
    const p = getTaskSystemPrompt('MindModelInductionTask');
    for (const field of [
      'knowledge_name',
      'subject_display_name',
      'evidence_samples',
      'question_prompt_md',
      'question_reference_md',
      'question_choices_md',
      'question_image_refs',
      'question_figures',
      'parent_question_id',
      'parent_question_prompt_md',
      'parent_question_reference_md',
      'parent_question_choices_md',
      'parent_question_image_refs',
      'parent_question_figures',
      'answer_md',
      'answer_image_refs',
      'reasoning_trace',
      'cause_attribution_md',
      'image_manifest',
    ]) {
      expect(p, `input contract must mention ${field}`).toContain(field);
    }
  });

  // YUK-786 — the old examples (链式法则 / 充分必要条件) were calculus + formal
  // logic while the live dataset is 语文: the prompt itself was steering the
  // model onto the wrong subject. Examples must now be structural, and the
  // subject must be declared to come from the input.
  it('carries no concrete-subject examples and pins the subject to the input', () => {
    for (const profileId of ['general', 'math', 'yuwen']) {
      const p = getTaskSystemPrompt('MindModelInductionTask', resolveSubjectProfile(profileId));
      expect(p, `${profileId}: calculus example leaked back in`).not.toContain('链式法则');
      expect(p, `${profileId}: logic example leaked back in`).not.toContain('充分必要条件');
      expect(p).toContain('一律以输入为准');
      expect(p).toContain('不得');
    }
  });

  it('requires the claim to be reproducible from the attached evidence', () => {
    const p = getTaskSystemPrompt('MindModelInductionTask');
    expect(p).toContain('能被随附证据复现');
    // Kept as a second-line guard even though the caller now drops empty cells:
    // a thin but non-empty sample still needs conservative specificity.
    expect(p).toContain('降到证据支持的抽象层级');
    expect(p).toContain('过滤为空');
  });

  it('states that mutable rows are filtered and real image blocks are attached in manifest order', () => {
    const p = getTaskSystemPrompt('MindModelInductionTask');
    expect(p).toContain('作答后被编辑过');
    expect(p).toContain('YUK-804');
    expect(p).toContain('真实图片块');
    expect(p).toContain('question（题图）');
    expect(p).toContain('parent_question（父题图）');
    expect(p).toContain('answer（作答图）');
    expect(p).toContain('解析不完整时调用方会整格失败');
  });

  it('frames untrusted learner text as data, never instruction', () => {
    const p = getTaskSystemPrompt('MindModelInductionTask');
    expect(p).toContain('untrusted_learner_text');
    expect(p).toContain('防注入');
  });

  it('renders the subject voice from the profile (no longer a fixed inline string)', () => {
    const yuwen = getTaskSystemPrompt('MindModelInductionTask', resolveSubjectProfile('yuwen'));
    const math = getTaskSystemPrompt('MindModelInductionTask', resolveSubjectProfile('math'));
    expect(yuwen).not.toBe(math);
    expect(yuwen).toContain(resolveSubjectProfile('yuwen').displayName);
    expect(math).toContain(resolveSubjectProfile('math').displayName);
  });
});

describe('Conjecture probe author/reviewer registry entries', () => {
  it('uses two separate bounded multimodal tasks with profile-aware prompts', () => {
    for (const kind of ['ConjectureProbeAuthorTask', 'ConjectureProbeReviewTask'] as const) {
      const def: TaskDef = tasks[kind];
      expect(def.needsToolCall).toBe(false);
      expect(def.isMultimodal).toBe(true);
      expect(def.allowedTools).toEqual([]);
      expect(def.budget.maxIterations).toBe(3);
      expect(def.budget.timeout).toBeGreaterThanOrEqual(180_000);
      expect(getTaskSystemPrompt(kind, resolveSubjectProfile('math'))).not.toBe(
        getTaskSystemPrompt(kind, resolveSubjectProfile('yuwen')),
      );
    }
  });

  it('author keeps the frozen trigger and emits gold plus target-error answers', () => {
    const p = getTaskSystemPrompt('ConjectureProbeAuthorTask');
    expect(p).toContain('frozen_hypothesis');
    expect(p).toContain('trigger_conditions_md');
    expect(p).toContain('expected_target_error_answer_md');
    expect(p).toContain('response_mode');
    expect(p).toContain('gold_response_signature');
    expect(p).toContain('target_error_response_signature');
    expect(p).toContain('context_kind');
    expect(p).toContain('representation_kind');
    expect(p).toContain('不能只换数字');
    expect(p).toContain('单选题');
    expect(p).toContain('恰好一个正确选项');
    expect(p).toContain('不是所有探针都必须是二元或单选');
    expect(p).toContain('multiple_select');
    expect(p).toContain('禁止把 gold 集合与目标错项做并集');
    expect(p).toContain('answer_with_reason');
    expect(p).toContain('constructed_response');
    expect(p).toContain('随机猜');
    expect(p).toContain('context_kind 和 representation_kind 两个字段都必须改变');
    expect(p).toContain('不能只改标签制造独立性');
    expect(p).toContain('必须真的含有可读表格');
    expect(p).toContain('prior_quality_failures');
    expect(p).toContain('不得写“下图”');
    expect(p).toContain('化简后等价');
    expect(p).toContain('重新独立解两题');
    expect(p).toContain('草稿痕迹');
    expect(p).toContain('条件少、可独立复算');
    expect(p).toContain('不得擅自改写题干条件');
    expect(p).toContain('不是逐字相等模板');
  });

  it('reviewer is independent, does not repair, and emits bounded failure codes', () => {
    const p = getTaskSystemPrompt('ConjectureProbeReviewTask');
    expect(p).toContain('没有参与出题');
    expect(p).toContain('不得替作者修题');
    expect(p).toContain('claim_scope_expansion');
    expect(p).toContain('probe_not_targeting');
    expect(p).toContain('probe_pair_not_independent');
    expect(p).toContain('reference_incorrect');
    expect(p).toContain('先独立解题');
    expect(p).toContain('逐项判断每个选项');
    expect(p).toContain('零个或多个正确选项');
    expect(p).toContain('reference 自己承认');
    expect(p).toContain('多个选项正确');
    expect(p).toContain('response_mode');
    expect(p).toContain('target_error_response_signature');
    expect(p).toContain('不是要求所有探针都做成二元选择');
    expect(p).toContain('随机猜');
    expect(p).toContain('其他普通干扰项');
    expect(p).toContain('不要求每个普通干扰项都来自本次目标误区');
    expect(p).toContain('choice');
    expect(p).toContain('单选和多选共用');
    expect(p).toContain('独立重算 gold 集合和 target-error 集合');
    expect(p).toContain('不存在的图片');
    expect(p).toContain('不信任作者自报');
    expect(p).toContain('纯文字题即使标成 table');
    expect(p).toContain('不是逐字字符串比较');
  });

  it('gives load-bearing semantic grouping enough structured-output budget', () => {
    const def: TaskDef = tasks.ConjectureGroupingTask;
    expect(def.budget.maxIterations).toBe(3);
    expect(def.budget.timeout).toBeGreaterThanOrEqual(120_000);
    expect(getTaskSystemPrompt('ConjectureGroupingTask')).toContain(
      'causal_direction_required 不同的 hypothesis 绝不能合并',
    );
  });
});

describe('Intervention preparation registry entries', () => {
  it('keeps recommendation narrow and gives the measured package author/reviewer enough time', () => {
    expect(tasks.InterventionRecommendationTask.budget.timeout).toBe(60_000);
    expect(tasks.InterventionPackageAuthorTask.budget.timeout).toBeGreaterThanOrEqual(180_000);
    expect(tasks.InterventionPackageReviewTask.budget.timeout).toBe(180_000);
  });
});

// YUK-572 — agent-led 教研例会 director task registry entry.
describe('ResearchMeetingDirectorTask registry entry', () => {
  it('is a tool-call loop on the Opus lane (override only, never default), 24 turns / 300s', () => {
    const def: TaskDef = tasks.ResearchMeetingDirectorTask;
    expect(def.kind).toBe('ResearchMeetingDirectorTask');
    // anthropic-sub is opt-in via per-call override only; NEVER a task default
    // (registry.ts:12-16 forbids it as defaultProvider so tests need no OAuth token).
    expect(def.defaultProvider).not.toBe('anthropic-sub');
    // unlike MindModelInductionTask, the director IS a tool-call loop.
    expect(def.needsToolCall).toBe(true);
    expect(def.isMultimodal).toBe(false);
    // registry default stays empty; the nightly orchestrator injects the real allowlist.
    expect(def.allowedTools).toEqual([]);
    // §7 wired run-away backstops: 24 turns + 300s wall-clock abort.
    expect(def.budget.maxIterations).toBe(24);
    expect(def.budget.timeout).toBe(300_000);
  });

  it('charter pins the three hard boundaries (propose-only / no-settlement / scout ≤1)', () => {
    const p = getTaskSystemPrompt('ResearchMeetingDirectorTask');
    // 1. propose-only red line.
    expect(p).toContain('propose-only');
    // 2. never touches settlement (θ̂ / mastery / FSRS).
    expect(p).toContain('不碰结算');
    expect(p).toContain('FSRS');
    // 3. scout depth cap = 1 (Task at most once; scout cannot re-spawn).
    expect(p).toContain('侦察兵 ≤1');
    expect(p).toContain('至多');
  });

  it('charter advertises review ids on the detail reader', () => {
    const p = getTaskSystemPrompt('ResearchMeetingDirectorTask');
    expect(p).toContain('get_attempt_details（按 attempt/review 事件 id');
  });

  it('charter permits review events as primary evidence', () => {
    const p = getTaskSystemPrompt('ResearchMeetingDirectorTask');
    expect(p).toContain('失败 attempt/review 事件 id');
    expect(p).toContain('不得引用 probe、prediction_score 或 agent_note id');
    expect(p).not.toContain('attempt/review/probe/prediction_score');
  });

  it('charter names the spawn + write tools the orchestrator injects', () => {
    const p = getTaskSystemPrompt('ResearchMeetingDirectorTask');
    expect(p).toContain('Task');
    expect(p).toContain('evidence-scout');
    expect(p).toContain('propose_conjecture');
    expect(p).toContain('leave_agent_note');
    expect(p).toContain('get_meeting_context');
    // anti-injection contract carried into the charter.
    expect(p).toContain('<untrusted_learner_text>');
  });
});

// YUK-576 — budget.transientRetries: the honest replacement for the deleted
// fallbackChain declarations. Same-resolved-target retry budget, consumed by the
// runner's transient-retry loop (runner.fallback.test.ts). Only the two vision
// judges opt in (they are synchronous-route sensors whose catch swallows into
// 'unsupported' — pg-boss never sees a throw, so no durable backstop exists).
describe('budget.transientRetries (YUK-576)', () => {
  it('both SDK outputFormat vision judges have a terminal turn after the envelope turn', () => {
    expect(tasks.StepsJudgeTask.budget.maxIterations).toBe(2);
    expect(tasks.MultimodalDirectJudgeTask.budget.maxIterations).toBe(2);
  });

  it('the two vision judges get exactly 1 same-target transient retry', () => {
    expect(tasks.StepsJudgeTask.budget.transientRetries).toBe(1);
    expect(tasks.MultimodalDirectJudgeTask.budget.transientRetries).toBe(1);
    // YUK-230 — SourceGroundingVerifyTask deliberately does NOT opt in: it runs inside the
    // durable source_verify pg-boss job (throws on transient → queue redelivery is the retry
    // layer), so an in-process retry would stack a second transient layer (single-transient-
    // layer principle). It is asserted to inherit 0 by the "every other task" case below.
    expect(tasks.SourceGroundingVerifyTask.budget.transientRetries).toBe(0);
  });

  it('every other task inherits the DEFAULT_BUDGET 0 (no in-process retry)', () => {
    const optedIn = new Set(['StepsJudgeTask', 'MultimodalDirectJudgeTask']);
    for (const [kind, def] of Object.entries(tasks)) {
      if (optedIn.has(kind)) continue;
      expect(def.budget.transientRetries, `${kind} must not opt into in-process retry`).toBe(0);
    }
  });
});

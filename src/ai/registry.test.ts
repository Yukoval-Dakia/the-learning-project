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

import { describe, expect, it } from 'vitest';
import { type TaskDef, tasks } from './registry';

describe('AttributionTask.systemPrompt', () => {
  it('emits Lane B field name analysis_md (not legacy ai_analysis_md)', () => {
    const p = tasks.AttributionTask.systemPrompt;
    expect(p).toContain('analysis_md');
    expect(p).not.toContain('ai_analysis_md');
  });

  it('frames input as attempt event with judge event downstream', () => {
    const p = tasks.AttributionTask.systemPrompt;
    expect(p).toContain('attempt event');
    expect(p).toContain('judge event');
    expect(p).toContain('caused_by_event_id');
  });

  // Codex P1-D — input fields must match AttributionInput (prompt_md,
  // reference_md, wrong_answer_md, knowledge_context). Prompt previously
  // referenced `event.payload.answer_md`, which doesn't match what runtime
  // actually sends, leaving the LLM guessing.
  it('references the flat AttributionInput field names (wrong_answer_md, not payload.answer_md)', () => {
    const p = tasks.AttributionTask.systemPrompt;
    expect(p).toContain('wrong_answer_md');
    expect(p).not.toContain('payload.answer_md');
    expect(p).not.toContain('event.payload.answer_md');
  });
});

describe('KnowledgeProposeTask.systemPrompt', () => {
  it('speaks attempt-event vocabulary, not legacy "做错的题"', () => {
    const p = tasks.KnowledgeProposeTask.systemPrompt;
    expect(p).toContain('attempt event');
    expect(p).toContain('referenced_knowledge_ids');
    expect(p).not.toContain('做错的题');
  });

  // Codex P1-E — input fields must match runtime input shape
  // { mistake_content: { prompt_md, reference_md, wrong_answer_md,
  //   knowledge_ids_picked }, tree_snapshot }. Prompt previously referenced
  // payload.referenced_knowledge_ids, payload.answer_md, question.prompt_md.
  it('references the mistake_content input shape (not payload.* or question.prompt_md)', () => {
    const p = tasks.KnowledgeProposeTask.systemPrompt;
    expect(p).toContain('mistake_content');
    expect(p).not.toContain('payload.answer_md');
    expect(p).not.toContain('question.prompt_md');
  });
});

describe('KnowledgeReviewTask.systemPrompt', () => {
  it('mentions attempt events + propose_knowledge_edge + relation_type', () => {
    const p = tasks.KnowledgeReviewTask.systemPrompt;
    expect(p).toContain('attempt event');
    expect(p).toContain('propose_knowledge_edge');
    expect(p).toContain('relation_type');
  });

  it('keeps tree-shape mutations enumerated', () => {
    const p = tasks.KnowledgeReviewTask.systemPrompt;
    expect(p).toContain('propose_new');
    expect(p).toContain('reparent');
    expect(p).toContain('merge');
    expect(p).toContain('split');
    expect(p).toContain('archive');
  });

  it('lists the 5 core relation_type enums', () => {
    const p = tasks.KnowledgeReviewTask.systemPrompt;
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
    expect(tasks.UnitDimensionFallback.systemPrompt).toContain('量纲');
  });
});

describe('MultimodalDirectJudgeTask registry entry', () => {
  it('is a single-call multimodal vision task (YUK-201)', () => {
    expect(tasks.MultimodalDirectJudgeTask.kind).toBe('MultimodalDirectJudgeTask');
    expect(tasks.MultimodalDirectJudgeTask.defaultProvider).toBe('xiaomi');
    expect(tasks.MultimodalDirectJudgeTask.defaultModel).toBe('mimo-v2.5');
    expect(tasks.MultimodalDirectJudgeTask.isMultimodal).toBe(true);
    expect(tasks.MultimodalDirectJudgeTask.needsToolCall).toBe(false);
    expect(tasks.MultimodalDirectJudgeTask.allowedTools).toEqual([]);
    expect(tasks.MultimodalDirectJudgeTask.budget.maxIterations).toBe(1);
    expect(tasks.MultimodalDirectJudgeTask.budget.timeout).toBe(90_000);
    // invocation defaults to 'auto' (graded via the multimodal_direct route, not a
    // manual rescue). The entry omits the optional field.
    expect((tasks.MultimodalDirectJudgeTask as TaskDef).invocation).toBeUndefined();
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

  it('uses the mimo-v2.5-pro default with mimo-v2.5 fallback', () => {
    expect(tasks.QuizGenTask.defaultProvider).toBe('xiaomi');
    expect(tasks.QuizGenTask.defaultModel).toBe('mimo-v2.5-pro');
    expect(tasks.QuizGenTask.fallbackChain).toEqual([{ provider: 'xiaomi', model: 'mimo-v2.5' }]);
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

  it('uses the mimo-v2.5-pro default with mimo-v2.5 fallback', () => {
    expect(tasks.QuizVerifyTask.defaultProvider).toBe('xiaomi');
    expect(tasks.QuizVerifyTask.defaultModel).toBe('mimo-v2.5-pro');
    expect(tasks.QuizVerifyTask.fallbackChain).toEqual([
      { provider: 'xiaomi', model: 'mimo-v2.5' },
    ]);
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

  it('uses the mimo-v2.5-pro default with mimo-v2.5 fallback', () => {
    expect(tasks.QuestionAuthorTask.defaultProvider).toBe('xiaomi');
    expect(tasks.QuestionAuthorTask.defaultModel).toBe('mimo-v2.5-pro');
    expect(tasks.QuestionAuthorTask.fallbackChain).toEqual([
      { provider: 'xiaomi', model: 'mimo-v2.5' },
    ]);
  });
});

// YUK-267 (C2) — pin the CopilotTask conversation-memory + ambient clauses so the
// history-preference prompt edit cannot silently regress.
describe('CopilotTask.systemPrompt — C2 memory + ambient clauses', () => {
  it('primes the model to prefer conversation_history over a redundant DomainTool read', () => {
    const p = tasks.CopilotTask.systemPrompt;
    expect(p).toContain('conversation_history');
    // The history-preference instruction keyword (Chinese copy may evolve, but the
    // field name + the "prefer history / avoid redundant tool read" intent stays).
    expect(p).toMatch(/优先复用|history-preference/);
  });

  it('explains ambient_context (current route + focused_entity)', () => {
    const p = tasks.CopilotTask.systemPrompt;
    expect(p).toContain('ambient_context');
    expect(p).toContain('focused_entity');
  });
});

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

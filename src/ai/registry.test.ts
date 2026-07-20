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

// Lane D (YUK-482): KnowledgeProposeTask.systemPrompt assertions removed — the
// task was deleted (answer-wrong → propose-new-KC coupling unwired).

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

// YUK-307 — pin the CopilotTask 【呈现提名】(primary_view) envelope clause. The
// chat.ts streaming tail-filter and extractPrimaryView's last-marker-wins
// semantics both depend on the marker being the reply's LAST output, so the
// 末尾/最后 placement wording is load-bearing, not copy.
describe('CopilotTask.systemPrompt — primary_view nomination clause (YUK-307)', () => {
  it('pins the marker syntax and the end-of-reply placement', () => {
    const p = tasks.CopilotTask.systemPrompt;
    expect(p).toContain('<!--primary_view:');
    // Placement contract: end of reply, the very last output.
    expect(p).toMatch(/末尾/);
    expect(p).toMatch(/最后一个输出/);
  });

  it('pins the three ruled sources and the default-no-hero criterion', () => {
    const p = tasks.CopilotTask.systemPrompt;
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
    const p = tasks.CopilotTask.systemPrompt;
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
    const p = tasks.ColdStartPlacementBridgeTask.systemPrompt;
    expect(p).toContain('known_subjects');
    expect(p).toContain('display_name');
    expect(p).toContain('aliases');
    // Opaque-id discipline: ids are copied back verbatim, never interpreted.
    expect(p).toMatch(/verbatim/i);
    expect(p).toMatch(/opaque/i);
  });

  it('no longer references the retired known_subject_ids string-array key', () => {
    expect(tasks.ColdStartPlacementBridgeTask.systemPrompt).not.toContain('known_subject_ids');
  });
});

// YUK-406 Phase 0 / YUK-440 A13 — conjecture induction task registry entry.
describe('MindModelInductionTask registry entry', () => {
  it('is a text-only single-shot task (Opus lane chosen per-call via override, never default)', () => {
    const def: TaskDef = tasks.MindModelInductionTask;
    expect(def.kind).toBe('MindModelInductionTask');
    // anthropic-sub is opt-in via override only; it is NEVER a task default
    // (registry.ts:12-16 forbids it as defaultProvider so tests need no OAuth token).
    expect(def.defaultProvider).not.toBe('anthropic-sub');
    expect(def.needsToolCall).toBe(false);
    expect(def.isMultimodal).toBe(false);
    expect(def.allowedTools).toEqual([]);
    expect(def.budget.maxIterations).toBe(1);
  });

  it('prompts for the A13 accountability fields (predicted_p + discriminating) and the 2nd-person framing', () => {
    const p = tasks.MindModelInductionTask.systemPrompt;
    expect(p).toContain('predicted_p');
    expect(p).toContain('discriminating');
    expect(p).toContain('第二人称');
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
    const p = tasks.ResearchMeetingDirectorTask.systemPrompt;
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
    const p = tasks.ResearchMeetingDirectorTask.systemPrompt;
    expect(p).toContain('get_attempt_details（按 attempt/review 事件 id');
  });

  it('charter permits review events as primary evidence', () => {
    const p = tasks.ResearchMeetingDirectorTask.systemPrompt;
    expect(p).toContain('attempt/review/probe/prediction_score');
    expect(p).not.toContain('evidence_refs 只能是 attempt/probe/prediction_score');
  });

  it('charter names the spawn + write tools the orchestrator injects', () => {
    const p = tasks.ResearchMeetingDirectorTask.systemPrompt;
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
  it('the two vision judges get exactly 1 same-target transient retry', () => {
    expect(tasks.StepsJudgeTask.budget.transientRetries).toBe(1);
    expect(tasks.MultimodalDirectJudgeTask.budget.transientRetries).toBe(1);
  });

  it('every other task inherits the DEFAULT_BUDGET 0 (no in-process retry)', () => {
    const optedIn = new Set(['StepsJudgeTask', 'MultimodalDirectJudgeTask']);
    for (const [kind, def] of Object.entries(tasks)) {
      if (optedIn.has(kind)) continue;
      expect(def.budget.transientRetries, `${kind} must not opt into in-process retry`).toBe(0);
    }
  });
});

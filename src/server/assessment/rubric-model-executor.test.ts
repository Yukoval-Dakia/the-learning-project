import { afterEach, describe, expect, it } from 'vitest';
import { formalRubricDeadlineAt } from '@/capabilities/practice/server/judge/evaluate-submission';
import { assessmentRubricTaskSpec } from '@/capabilities/practice/tasks/assessment-rubric';
import { resolveTaskBudget } from '@/capabilities/task-registry';
import {
  ASSESSMENT_RUBRIC_ESTIMATED_ATTEMPT_MICROS,
  assessmentRubricInvocationWindowMs,
  assessmentRubricTimeoutFromCensoredHoldout,
} from '@/core/assessment-rubric-timeout';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import type { ModelExecutorRequest, ScoringUnitT } from '@/core/schema/assessment';
import { AgentRunError } from '@/ai/agent-run-error';
import type { RunTaskCtx, RunTaskResult } from '@/server/ai/runner';
import { ASSESSMENT_RUBRIC_TASK_KIND, createRubricModelExecutor } from './rubric-model-executor';

afterEach(() => {
  resetTestConfig();
});

function rubricUnit(): ScoringUnitT {
  return {
    scoring_unit_id: 'u1',
    slot_refs: ['s1'],
    material_refs: [],
    evidence_slot_refs: [],
    requires_group_evidence: false,
    criterion: {
      kind: 'rubric',
      criteria: [
        {
          criterion_id: 'c1',
          statement_md: 'Award the derivative when the submitted step shows it.',
          max: 1,
          allowed_awards: [0, 1],
        },
      ],
      crossed_out_steps: 'ignore',
    },
    points: 1,
  };
}

function request(cap: number): ModelExecutorRequest {
  return {
    submission_id: 'sub_1',
    evaluation_group_id: 'grp_1',
    revision_id: 'rev_1',
    attempt: 1,
    scoring_unit_id: 'u1',
    executor: {
      kind: 'model_executor',
      task_kind: 'AssessmentRubricJudgeTask',
      admitted_slice_id: 'slice_rubric',
      max_cost_usd_micros: cap,
    },
    unit: rubricUnit(),
    question_parts: [{ part_id: 'p1', prompt_md: '求导数。', material_ids: [] }],
    response_slots: [{ slot_id: 's1', part_id: 'p1', kind: 'text', math_preview: false }],
    slot_responses: [{ slot_id: 's1', kind: 'text', text_md: 'x = 4' }],
    group_evidence: [],
    materials: [],
    spent_cost_usd_micros: 0,
  };
}

function scoredResult(taskRunId: string): RunTaskResult {
  return {
    task_run_id: taskRunId,
    text: '{}',
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 4 },
    cost_usd: 0.0008,
    cost_basis: 'reported',
    cost_ref: 'test',
    structured_output: {
      kind: 'awards',
      awards: [
        {
          criterion_id: 'c1',
          award: 1,
          reason: 'the submitted step is the derivative',
          evidence_citations: [{ slot_id: 's1', quote: 'x = 4' }],
        },
      ],
    },
  };
}

function timeoutError(taskRunId: string): AgentRunError {
  return new AgentRunError({
    kind: ASSESSMENT_RUBRIC_TASK_KIND,
    taskRunId,
    subtype: 'budget_timeout',
    errors: ['budget timeout'],
  });
}

function armedTimeout(
  runTask: (
    kind: typeof ASSESSMENT_RUBRIC_TASK_KIND,
    input: unknown,
    ctx: RunTaskCtx,
  ) => Promise<RunTaskResult>,
  cap: number,
): Promise<number> {
  let timeoutMs = -1;
  const executor = createRubricModelExecutor({
    db: {} as never,
    deadlineAt:
      Date.now() +
      assessmentRubricInvocationWindowMs(resolveTaskBudget(ASSESSMENT_RUBRIC_TASK_KIND).timeout) +
      5_000,
    maxCostUsdMicros: cap,
    runTask: async (kind, input, ctx) => {
      timeoutMs = ctx.budgetOverride?.timeoutMs ?? -1;
      return runTask(kind, input, ctx);
    },
  });
  return executor(request(cap)).then(() => timeoutMs);
}

describe('rubric timeout and timeout cost', () => {
  // @invariant grading: the rubric call uses the resolved budget timeout, defaulted from the censored holdout, with a second full window
  // @fails-if the armed timeout stays 90s, a task budget override is ignored, or the formal deadline is still one 90s window
  it('arms the configured timeout and keeps a second window for the retry', async () => {
    resetTestConfig();
    const derived = assessmentRubricTimeoutFromCensoredHoldout();
    expect(derived).toBe(180_000);
    expect(assessmentRubricTaskSpec.definition.budget.timeout).toBe(derived);
    expect(resolveTaskBudget(ASSESSMENT_RUBRIC_TASK_KIND).timeout).toBe(derived);
    expect(formalRubricDeadlineAt(0)).toBe(assessmentRubricInvocationWindowMs(derived));
    const defaultArmed = await armedTimeout(async () => scoredResult('run-default'), 20_000);
    expect(defaultArmed).toBe(derived);

    setTestConfig({
      'task.AssessmentRubricJudgeTask.budget': { timeout: 240_000 },
    });
    expect(resolveTaskBudget(ASSESSMENT_RUBRIC_TASK_KIND).timeout).toBe(240_000);
    expect(formalRubricDeadlineAt(0)).toBe(480_000);
    const overrideArmed = await armedTimeout(async () => scoredResult('run-override'), 20_000);
    expect(overrideArmed).toBe(240_000);
  });

  // @invariant grading: a rubric timeout is retried once when another estimated attempt still fits under the cap, and that timeout is not agreement
  // @fails-if a timeout never retries, a third call is issued, or the timed-out attempt's reservation is returned as known cost on the scored retry
  it('retries one timeout when the estimated attempt still fits under the cap', async () => {
    const cap = ASSESSMENT_RUBRIC_ESTIMATED_ATTEMPT_MICROS * 2;
    const calls: string[] = [];
    const executor = createRubricModelExecutor({
      db: {} as never,
      deadlineAt: Date.now() + assessmentRubricInvocationWindowMs(180_000) + 5_000,
      maxCostUsdMicros: cap,
      runTask: async (_kind, _input, ctx) => {
        const id = calls.length === 0 ? 'run-timeout' : 'run-retry';
        calls.push(id);
        await ctx.beforeProviderQuery?.({
          taskRunId: id,
          provider: 'opencode-go',
          model: 'mimo-v2.6-pro',
        });
        if (calls.length === 1) throw timeoutError(id);
        return scoredResult(id);
      },
    });
    const outcome = await executor(request(cap));
    expect(calls).toEqual(['run-timeout', 'run-retry']);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.points_awarded).toBe(1);
    expect(outcome.cost_usd_micros).toBeUndefined();
    expect(outcome.run_refs).toEqual(['run-timeout', 'run-retry']);
  });

  // @invariant grading: a rubric timeout whose next estimated attempt would exceed the cap is a non-pass with unknown cost
  // @fails-if a second paid call starts after the estimate no longer fits, or the reserved cap is returned as cost_usd_micros
  it('does not retry a timeout the cap cannot pay for, and does not book the reservation as known cost', async () => {
    const cap = ASSESSMENT_RUBRIC_ESTIMATED_ATTEMPT_MICROS;
    let calls = 0;
    const executor = createRubricModelExecutor({
      db: {} as never,
      deadlineAt: Date.now() + assessmentRubricInvocationWindowMs(180_000) + 5_000,
      maxCostUsdMicros: cap,
      runTask: async (_kind, _input, ctx) => {
        calls += 1;
        await ctx.beforeProviderQuery?.({
          taskRunId: 'run-timeout',
          provider: 'opencode-go',
          model: 'mimo-v2.6-pro',
        });
        throw timeoutError('run-timeout');
      },
    });
    const outcome = await executor(request(cap));
    expect(calls).toBe(1);
    expect(outcome.kind).toBe('pending');
    if (outcome.kind !== 'pending') return;
    expect(outcome.pending.reason).toBe('infra_failure');
    expect(outcome.cost_usd_micros).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  deterministicExecutionProvenance,
  historicalUnknownExecutionProvenance,
  resolveModelExecutionProvenance,
  suppliedUnverifiedExecutionProvenance,
} from './execution-provenance-resolve';

const execution = {
  task_kind: 'SemanticJudgeTask',
  task_run_id: 'tr-1',
  input_hash: 'a'.repeat(64),
  prompt_fingerprint: 'b'.repeat(64),
  prompt_template_revision: 'judge-prompt-v1',
};

describe('model execution provenance resolution', () => {
  it('copies provider/model only from an exactly matching task run', () => {
    expect(
      resolveModelExecutionProvenance(execution, 'supplied_verified', {
        id: 'tr-1',
        task_kind: 'SemanticJudgeTask',
        input_hash: 'a'.repeat(64),
        provider: 'anthropic-sub',
        model: 'claude-opus-4-8',
      }),
    ).toMatchObject({
      kind: 'supplied_verified',
      task_run_id: 'tr-1',
      provider: 'anthropic-sub',
      model: 'claude-opus-4-8',
    });
  });

  it('retains invoked kind without inventing provider/model when the task row is unavailable', () => {
    const result = resolveModelExecutionProvenance(execution, 'invoked');
    expect(result.kind).toBe('invoked');
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('marks deterministic execution without a fake model run', () => {
    const result = deterministicExecutionProvenance('exact');
    expect(result.kind).toBe('deterministic');
    expect(result.task_run_id).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('marks supplied model results unverified even without a task run reference', () => {
    const result = suppliedUnverifiedExecutionProvenance('semantic');
    expect(result.kind).toBe('supplied_unverified');
    expect(result.task_run_id).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('marks missing legacy execution identity historical unknown', () => {
    expect(historicalUnknownExecutionProvenance('semantic').kind).toBe('historical_unknown');
  });

  it.each([
    ['task kind', { task_kind: 'StepsJudgeTask' }],
    ['input identity', { input_hash: 'c'.repeat(64) }],
    ['run identity', { id: 'tr-other' }],
  ])('marks a supplied run unverified on mismatched %s', (_label, mismatch) => {
    const result = resolveModelExecutionProvenance(execution, 'supplied_verified', {
      id: 'tr-1',
      task_kind: 'SemanticJudgeTask',
      input_hash: 'a'.repeat(64),
      provider: 'anthropic-sub',
      model: 'claude-opus-4-8',
      ...mismatch,
    });
    expect(result.kind).toBe('supplied_unverified');
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });
});

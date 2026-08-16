import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import {
  deterministicExecutionProvenance,
  historicalUnknownExecutionProvenance,
  modelExecutionProvenance,
  resolveModelExecutionProvenance,
  suppliedUnverifiedExecutionProvenance,
} from './execution-provenance-resolve';

const execution = {
  task_kind: 'SemanticJudgeTask',
  task_run_id: 'tr-1',
  input_hash: 'a'.repeat(64),
  prompt_fingerprint: 'b'.repeat(64),
  prompt_template_revision: 'judge-prompt-v1',
  // YUK-589 — the digest of the exact result the caller wants trusted.
  result_digest: 'd'.repeat(64),
};

// A run row whose persisted prompt/result identity matches the supplied claim.
const matchingRun = {
  id: 'tr-1',
  task_kind: 'SemanticJudgeTask',
  input_hash: 'a'.repeat(64),
  provider: 'anthropic-sub',
  model: 'claude-opus-4-8',
  status: 'success',
  finished_at: new Date(),
  prompt_fingerprint: 'b'.repeat(64),
  result_digest: 'd'.repeat(64),
};

describe('model execution provenance resolution', () => {
  it('copies provider/model only from a run whose persisted prompt/result identity matches', () => {
    expect(
      resolveModelExecutionProvenance(execution, 'supplied_verified', matchingRun),
    ).toMatchObject({
      kind: 'supplied_verified',
      task_run_id: 'tr-1',
      provider: 'anthropic-sub',
      model: 'claude-opus-4-8',
    });
  });

  it('downgrades invoked provenance when authoritative completion evidence is unavailable', () => {
    const result = resolveModelExecutionProvenance(execution, 'invoked');
    expect(result.kind).toBe('historical_unknown');
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

  // YUK-589 (Finding 4) — an explicitly unverified input must never be promoted,
  // even against a fully matching run row.
  it('never promotes a supplied_unverified request to supplied_verified', () => {
    const result = resolveModelExecutionProvenance(execution, 'supplied_unverified', matchingRun);
    expect(result.kind).toBe('supplied_unverified');
    expect(result.task_run_id).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  // YUK-589 (Finding 1) — DB corroboration must fail when the persisted prompt or
  // result identity differs from the supplied claim, and when the run persisted
  // no digests (legacy row) or the claim carries no result digest at all.
  it.each([
    ['persisted prompt fingerprint', { prompt_fingerprint: 'c'.repeat(64) }],
    ['persisted result digest', { result_digest: 'e'.repeat(64) }],
    ['unpersisted prompt fingerprint (legacy row)', { prompt_fingerprint: null }],
    ['unpersisted result digest (legacy row)', { result_digest: null }],
  ])('refuses to verify a supplied run on mismatched %s', (_label, mismatch) => {
    const result = resolveModelExecutionProvenance(execution, 'supplied_verified', {
      ...matchingRun,
      ...mismatch,
    });
    expect(result.kind).toBe('supplied_unverified');
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('refuses to verify when the claim carries no result digest', () => {
    const { result_digest: _drop, ...withoutDigest } = execution;
    const result = resolveModelExecutionProvenance(withoutDigest, 'supplied_verified', matchingRun);
    expect(result.kind).toBe('supplied_unverified');
    expect(result.provider).toBeUndefined();
  });

  it.each([
    ['task kind', { task_kind: 'StepsJudgeTask' }],
    ['input identity', { input_hash: 'c'.repeat(64) }],
    ['run identity', { id: 'tr-other' }],
    ['running status', { status: 'running', finished_at: null }],
    ['failed status', { status: 'failure' }],
  ])('marks a supplied run unverified on mismatched %s', (_label, mismatch) => {
    const result = resolveModelExecutionProvenance(execution, 'supplied_verified', {
      ...matchingRun,
      ...mismatch,
    });
    expect(result.kind).toBe('supplied_unverified');
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  // YUK-589 (K3a) — a DB blip during the ai_task_runs lookup must be CONTAINED,
  // never crash the submit/paper/rejudge write path. A throwing db degrades
  // fail-closed: the supplied path → supplied_unverified, the invoked path →
  // historical_unknown. execution_provenance is an audit stamp, not a gate.
  const throwingDb = {
    select() {
      throw new Error('__DB_DOWN__');
    },
  } as unknown as Db;

  it('degrades a supplied claim to supplied_unverified when the ai_task_runs lookup throws', async () => {
    await expect(
      modelExecutionProvenance(throwingDb, execution, 'supplied_verified'),
    ).resolves.toMatchObject({ kind: 'supplied_unverified' });
  });

  it('degrades an invoked claim to historical_unknown when the ai_task_runs lookup throws', async () => {
    const result = await modelExecutionProvenance(throwingDb, execution, 'invoked');
    expect(result.kind).toBe('historical_unknown');
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });
});

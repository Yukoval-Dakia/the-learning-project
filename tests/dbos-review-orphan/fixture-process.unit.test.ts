import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChildExit,
  assertFixtureCanReset,
  assertSettledCronLedger,
  cleanupOwnedChildren,
  errorDiagnostic,
  fixtureErrorMessage,
  fixtureMessageSchema,
  nonterminalDurableWork,
  waitForFixtureMessage,
} from './fixture-process';

afterEach(() => vi.useRealTimers());

function ownedChild(pid: number, exitCode: number | null = null) {
  const { promise: exited, resolve: exit } = Promise.withResolvers<ChildExit>();
  const child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'> = {
    pid,
    exitCode,
    signalCode: null,
    kill: vi.fn(() => true),
  };
  return { child, exited, exit };
}

describe('review fixture failure evidence', () => {
  it('retains a nested PostgreSQL cause, SQLSTATE and available worker identity without credentials', () => {
    const url = 'postgres://test:encoded%21secret@127.0.0.1:5432/test_fork_1';
    const pgError = Object.assign(new Error(`deadlock detected at ${url}`), {
      code: '40P01',
      severity: 'ERROR',
      table: 'job',
      schema: 'pgboss',
      constraint: 'producer_fence',
      detail: 'Process 123 waits for lock; password=other-secret',
      hint: 'token="another-secret"; Bearer bearer-secret',
      query: 'DO NOT INCLUDE secret query parameters',
    });
    const wrapped = new Error('Failed query: DROP TRIGGER review ON pgboss.job', {
      cause: new Error('transaction failed', { cause: pgError }),
    });
    const failure = fixtureErrorMessage({
      kind: 'failure',
      error: wrapped,
      pid: 789,
      database: 'test_fork_1',
      stage: 'durable-host-start',
      requestId: 'review-crash-owned',
      secrets: [url, 'encoded!secret'],
    });
    expect(failure).toMatchObject({
      kind: 'failure',
      pid: 789,
      database: 'test_fork_1',
      stage: 'durable-host-start',
      requestId: 'review-crash-owned',
    });
    expect(failure.diagnostic.cause?.cause?.fields).toMatchObject({
      code: '40P01',
      sqlstate: '40P01',
      table: 'job',
      schema: 'pgboss',
      constraint: 'producer_fence',
      severity: 'ERROR',
    });
    const output = JSON.stringify(failure);
    expect(output).toContain('Process 123 waits for lock');
    for (const secret of [
      url,
      'encoded%21secret',
      'encoded!secret',
      'other-secret',
      'another-secret',
      'bearer-secret',
      'secret query parameters',
    ])
      expect(output).not.toContain(secret);
  });
  it('bounds long cause chains, cycles and individual fields', () => {
    const cycle = new Error('x'.repeat(20000));
    cycle.cause = cycle;
    const diagnostic = errorDiagnostic(cycle);
    expect(diagnostic.fields.message).toHaveLength(2048);
    expect(diagnostic.fields.stack.length).toBeLessThanOrEqual(4096);
    expect(diagnostic.cause?.truncated).toBe(true);
    let error = new Error('bottom');
    for (let i = 0; i < 20; i++) error = new Error(`layer-${i}`, { cause: error });
    expect(JSON.stringify(errorDiagnostic(error))).not.toContain('bottom');
    expect(JSON.stringify(errorDiagnostic(error))).toContain('truncated');
  });
  it('preserves the existing review cron rejection text while adding cause diagnostics', () => {
    const error = new Error('Review orphan drain blocked: [{"kind":"forwarder","state":"active"}]');
    const message = fixtureErrorMessage({
      kind: 'rejected',
      error,
      pid: 1,
      stage: 'command-transition',
    });
    expect(message.error).toContain('"kind":"forwarder"');
    expect(message.error).toContain('"state":"active"');
  });
});

describe('fixture IPC', () => {
  it('surfaces an unexpected rejected task immediately with evidence instead of waiting for ack', async () => {
    vi.useFakeTimers();
    const messages = [
      fixtureMessageSchema.parse({
        kind: 'rejected',
        error: 'Drain blocked: task 5fbf047e state created',
      }),
    ];
    await expect(
      waitForFixtureMessage({
        messages,
        expected: 'ack',
        exited: () => false,
        evidence: () => ({ pid: 47443, messages }),
        timeoutMs: 90000,
      }),
    ).rejects.toThrow(/5fbf047e.*47443/);
    expect(vi.getTimerCount()).toBe(0);
    expect(messages).toHaveLength(1);
  });
  it.each(['rejected', 'ack-or-rejected'])('preserves explicit %s callers', async (expected) => {
    const message = fixtureMessageSchema.parse({ kind: 'rejected', error: 'Rollback cooldown' });
    await expect(
      waitForFixtureMessage({
        messages: [message],
        expected,
        exited: () => false,
        evidence: () => ({}),
        timeoutMs: 10000,
      }),
    ).resolves.toEqual(message);
  });
  it('retains the expected terminal failure and rejects an already exited child promptly', async () => {
    const message = fixtureMessageSchema.parse({
      kind: 'failure',
      error: 'Review orphan outcome unknown: owned/crash-a',
    });
    await expect(
      waitForFixtureMessage({
        messages: [message],
        expected: 'failure',
        exited: () => true,
        evidence: () => ({}),
        timeoutMs: 30000,
      }),
    ).resolves.toEqual(message);
    await expect(
      waitForFixtureMessage({
        messages: [],
        expected: 'ready',
        exited: () => true,
        evidence: () => ({ pid: 44, exit: [1, null] }),
        timeoutMs: 30000,
      }),
    ).rejects.toThrow(/exited.*44/);
  });
  it('consumes ready before a later expected terminal failure already in the IPC queue', async () => {
    const messages = [
      { kind: 'ready' },
      { kind: 'failure', error: 'Review orphan outcome unknown' },
    ];
    const options = { messages, exited: () => true, evidence: () => messages, timeoutMs: 30000 };
    await expect(waitForFixtureMessage({ ...options, expected: 'ready' })).resolves.toMatchObject({
      kind: 'ready',
    });
    await expect(waitForFixtureMessage({ ...options, expected: 'failure' })).resolves.toMatchObject(
      { kind: 'failure' },
    );
  });
  it('binds a boundary to the requested workflow without consuming a different workflow observation', async () => {
    const messages = [
      fixtureMessageSchema.parse({ kind: 'boundary', workflowId: 'prior' }),
      fixtureMessageSchema.parse({ kind: 'boundary', workflowId: 'owned' }),
    ];
    const observed = await waitForFixtureMessage({
      messages,
      expected: 'boundary',
      exited: () => false,
      evidence: () => ({}),
      timeoutMs: 30000,
      accept: (m) => m.workflowId === 'owned',
    });
    expect(observed.workflowId).toBe('owned');
    expect(messages).toEqual([{ kind: 'boundary', workflowId: 'prior' }]);
  });
});

describe('per-case child cleanup', () => {
  it('captures the duplicate-start failure before reaping a surviving ready worker with recorded exits', async () => {
    vi.useFakeTimers();
    const survivor = ownedChild(101);
    const duplicate = ownedChild(102, 1);
    duplicate.exit([1, null]);
    const children = new Map([
      [survivor.child, survivor.exited],
      [duplicate.child, duplicate.exited],
    ]);
    const ipc = [
      { pid: 101, kind: 'ready' },
      { pid: 102, kind: 'failure', error: 'nested SQL cause captured' },
    ];
    const beforeCleanup = structuredClone(ipc);
    expect(() => assertFixtureCanReset(children.keys())).toThrow('101');
    const cleanup = cleanupOwnedChildren(children);
    await vi.advanceTimersByTimeAsync(1000);
    expect(survivor.child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(survivor.child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    survivor.exit([null, 'SIGKILL']);
    await cleanup;
    expect(duplicate.child.kill).not.toHaveBeenCalled();
    expect(children.size).toBe(0);
    expect(() => assertFixtureCanReset(children.keys())).not.toThrow();
    expect(beforeCleanup).toEqual(ipc);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not report cleanup success without the exit promise settling', async () => {
    vi.useFakeTimers();
    const child = ownedChild(201);
    const children = new Map([[child.child, child.exited]]);
    const cleanup = expect(cleanupOwnedChildren(children, 100, 200)).rejects.toThrow(
      'cleanup failed',
    );
    await vi.advanceTimersByTimeAsync(300);
    await cleanup;
    expect(children.size).toBe(1);
    expect(() => assertFixtureCanReset(children.keys())).toThrow('201');
  });
  it('fails later resets closed for pending, enqueued, delayed and unrecognized durable states', () => {
    const workflows = [
      'SUCCESS',
      'ERROR',
      'CANCELLED',
      'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
      'PENDING',
      'ENQUEUED',
      'DELAYED',
      'NEW_UNKNOWN_STATUS',
    ].map((status) => ({ workflow_uuid: `owned-${status}`, status }));
    const unsettled = nonterminalDurableWork(workflows);
    expect(unsettled.map((row) => row.status)).toEqual([
      'PENDING',
      'ENQUEUED',
      'DELAYED',
      'NEW_UNKNOWN_STATUS',
    ]);
    const reset = vi.fn();
    expect(() => {
      assertFixtureCanReset([], JSON.stringify(unsettled));
      reset();
    }).toThrow(/evidence preserved.*owned-PENDING/);
    expect(reset).not.toHaveBeenCalled();
    expect(workflows).toHaveLength(8);
  });
});

describe('retained two-scenario cron ledger', () => {
  function ledger() {
    return {
      workflows: ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'].map(
        (name) => ({ name, workflow_uuid: `sched-${name}-point`, status: 'SUCCESS' }),
      ),
      ticks: ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'].map(
        (family) => ({
          family,
          tick_id: `sched-${family}-point`,
          backend: 'dbos',
          admission: 'admitted',
          candidates: [
            {
              sessionId: `${family}-a`,
              selectedVersion: 12,
              selectedStartedAt: '2026-10-08 13:14:41.268340+00',
            },
            {
              sessionId: `${family}-b`,
              selectedVersion: 0,
              selectedStartedAt: '2026-10-08 13:14:41.268341+00',
            },
          ],
        }),
      ),
      receipts: ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'].flatMap(
        (family) =>
          ['a', 'b'].map((suffix) => ({
            family,
            tick_id: `sched-${family}-point`,
            session_id: `${family}-${suffix}`,
            outcome: {
              kind: 'abandoned',
              fromVersion: suffix === 'a' ? 12 : 0,
              toVersion: suffix === 'a' ? 13 : 1,
            },
          })),
      ),
    };
  }
  it('accepts both families retained with exact native headers and every frozen receipt, without mutating history', () => {
    const before = ledger();
    const after = structuredClone(before);
    after.workflows.push({
      name: before.workflows[0].name,
      workflow_uuid: 'new-empty-point',
      status: 'SUCCESS',
    });
    after.ticks.push({ ...before.ticks[0], tick_id: 'new-empty-point', candidates: [] });
    expect(() => assertSettledCronLedger(before)).not.toThrow();
    expect(() => assertSettledCronLedger(after)).not.toThrow();
    expect(after.receipts).toEqual(before.receipts);
    expect(before.workflows).toHaveLength(2);
    expect(before.ticks).toHaveLength(2);
  });
  it.each([
    'missing-header',
    'wrong-family-header',
    'missing-workflow',
    'missing-receipt',
    'pending',
    'unknown-error',
  ])('rejects %s before a later scenario can change phases', (defect) => {
    const state = ledger();
    if (defect === 'missing-header') state.ticks.shift();
    else if (defect === 'wrong-family-header') state.ticks[0].family = state.ticks[1].family;
    else if (defect === 'missing-workflow') state.workflows.shift();
    else if (defect === 'missing-receipt') state.receipts.pop();
    else state.workflows[0].status = defect === 'pending' ? 'PENDING' : 'ERROR';
    const phaseReset = vi.fn();
    expect(() => {
      assertSettledCronLedger(state);
      phaseReset();
    }).toThrow();
    expect(phaseReset).not.toHaveBeenCalled();
  });
});

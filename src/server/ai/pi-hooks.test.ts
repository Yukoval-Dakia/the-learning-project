// YUK-921 P3 (YUK-1022) — pi hook bridge units. Pure no-DB: the bridge is a
// pure function layer over caller-declared callbacks (ordered gates +
// observers); nothing here imports the engine, DB, or SDK runtime.

import { describe, expect, it, vi } from 'vitest';
import {
  type PiHookBridge,
  type PiHookToolCall,
  type PiToolCallObservation,
  emitPiAfterToolCall,
  runPiBeforeToolCall,
} from './pi-hooks';

const CALL: PiHookToolCall = { id: 'call_1', name: 'mcp__loom__read_mistakes' };

describe('runPiBeforeToolCall', () => {
  it('returns undefined for an absent or empty bridge', async () => {
    expect(await runPiBeforeToolCall(undefined, CALL, {})).toBeUndefined();
    expect(await runPiBeforeToolCall({}, CALL, {})).toBeUndefined();
    expect(await runPiBeforeToolCall({ beforeToolCall: [] }, CALL, {})).toBeUndefined();
  });

  it('runs entries in order; the first defined result short-circuits the rest', async () => {
    const calls: string[] = [];
    const bridge: PiHookBridge = {
      beforeToolCall: [
        () => {
          calls.push('first');
          return undefined;
        },
        async () => {
          calls.push('second');
          return { block: true, reason: 'budget' };
        },
        () => {
          calls.push('third');
          return undefined;
        },
      ],
    };
    const result = await runPiBeforeToolCall(bridge, CALL, { q: 'x' });
    expect(result).toEqual({ block: true, reason: 'budget' });
    expect(calls).toEqual(['first', 'second']);
  });

  it('threads call, args and the abort signal into every entry', async () => {
    const seen: Array<{ call: PiHookToolCall; args: unknown; signal?: AbortSignal }> = [];
    const signal = new AbortController().signal;
    const bridge: PiHookBridge = {
      beforeToolCall: [
        (call, args, sig) => {
          seen.push({ call, args, signal: sig });
          return undefined;
        },
      ],
    };
    await runPiBeforeToolCall(bridge, { ...CALL, agentType: 'scout' }, { a: 1 }, signal);
    expect(seen).toEqual([{ call: { ...CALL, agentType: 'scout' }, args: { a: 1 }, signal }]);
  });

  it('a non-blocking defined result ({block:false}) still short-circuits — the decider is authoritative', async () => {
    const calls: string[] = [];
    const bridge: PiHookBridge = {
      beforeToolCall: [
        () => {
          calls.push('decider');
          return { block: false };
        },
        () => {
          calls.push('later');
          return { block: true, reason: 'must not run' };
        },
      ],
    };
    expect(await runPiBeforeToolCall(bridge, CALL, {})).toEqual({ block: false });
    expect(calls).toEqual(['decider']);
  });
});

describe('emitPiAfterToolCall', () => {
  const observation: PiToolCallObservation = {
    call: CALL,
    args: { q: 'x' },
    isError: false,
    output: [{ type: 'text', text: 'tool output' }],
  };

  it('returns undefined for an absent or empty bridge', async () => {
    expect(await emitPiAfterToolCall(undefined, observation)).toBeUndefined();
    expect(await emitPiAfterToolCall({}, observation)).toBeUndefined();
  });

  it('fans the observation to every observer in declaration order', async () => {
    const order: string[] = [];
    const bridge: PiHookBridge = {
      afterToolCall: [
        async (obs) => {
          order.push(`a:${obs.isError}`);
          return undefined;
        },
        (obs) => {
          order.push(`b:${obs.call.name}`);
          return undefined;
        },
      ],
    };
    await emitPiAfterToolCall(bridge, observation);
    expect(order).toEqual(['a:false', 'b:mcp__loom__read_mistakes']);
  });

  it('merges overrides field-wise — later defined fields win', async () => {
    const bridge: PiHookBridge = {
      afterToolCall: [
        () => ({ content: [{ type: 'text', text: 'v1' }] }) as never,
        () => ({ blocked: true }) as never,
        () => ({ content: [{ type: 'text', text: 'v2' }] }) as never,
      ],
    };
    const merged = await emitPiAfterToolCall(bridge, observation);
    expect(merged).toEqual({
      content: [{ type: 'text', text: 'v2' }],
      blocked: true,
    });
  });

  it('fails open on observer errors — later observers still run and merge', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const bridge: PiHookBridge = {
      afterToolCall: [
        () => {
          order.push('before');
          return undefined;
        },
        () => {
          order.push('boom');
          throw new Error('observer exploded');
        },
        () => {
          order.push('after');
          return { blocked: true } as never;
        },
      ],
    };
    const merged = await emitPiAfterToolCall(bridge, observation);
    expect(order).toEqual(['before', 'boom', 'after']);
    expect(merged).toEqual({ blocked: true });
    expect(warn).toHaveBeenCalledWith(
      '[pi-hooks] afterToolCall observer failed (continuing)',
      expect.objectContaining({ tool_use_id: 'call_1', error: 'observer exploded' }),
    );
    warn.mockRestore();
  });

  it('carries isError/error/interrupted through the observation verbatim', async () => {
    let seen: PiToolCallObservation | undefined;
    const bridge: PiHookBridge = {
      afterToolCall: [
        (obs) => {
          seen = obs;
          return undefined;
        },
      ],
    };
    const failed: PiToolCallObservation = {
      ...observation,
      isError: true,
      error: [{ type: 'text', text: 'tool exploded' }],
      interrupted: true,
    };
    await emitPiAfterToolCall(bridge, failed);
    expect(seen).toEqual(failed);
  });
});

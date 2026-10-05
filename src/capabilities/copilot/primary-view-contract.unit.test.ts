import { describe, expect, it } from 'vitest';
import {
  CopilotPrimaryViewSchema,
  CopilotToolResultSnapshotSchema,
  parseCopilotPrimaryView,
} from './primary-view-contract';

const value = {
  observations: [{ estimate: 0, evidence: null, approved: false, note: '', children: [] }],
  coverage: { has_more: true },
  context_budget: { truncated: true },
};
const snapshot = {
  version: 1 as const,
  state: 'available' as const,
  value,
  sha256: 'a'.repeat(64),
  byte_length: new TextEncoder().encode(JSON.stringify(value)).byteLength,
  completeness: 'complete' as const,
  omissions: [],
};
const view = {
  source: 'tool_result' as const,
  ref: { kind: 'query_knowledge', id: 'root-call' },
  snapshot,
};

describe('Copilot primary-view public contract', () => {
  it('roundtrips exact zero, unknown, false, empty values and source coverage', () => {
    const decoded = CopilotPrimaryViewSchema.parse(JSON.parse(JSON.stringify(view)));
    expect(decoded).toEqual(view);
    expect(parseCopilotPrimaryView(decoded)).toEqual(view);
  });

  it('rejects false size claims, oversized values and false completeness', () => {
    expect(CopilotToolResultSnapshotSchema.safeParse({ ...snapshot, byte_length: 0 }).success).toBe(
      false,
    );
    const huge = '汉'.repeat(12_000);
    expect(
      CopilotToolResultSnapshotSchema.safeParse({
        ...snapshot,
        value: huge,
        byte_length: new TextEncoder().encode(JSON.stringify(huge)).byteLength,
      }).success,
    ).toBe(false);
    expect(
      CopilotToolResultSnapshotSchema.safeParse({
        ...snapshot,
        omissions: [{ path: '/private', reason: 'private' }],
      }).success,
    ).toBe(false);
  });

  it('retains legacy identity if optional historical snapshot is corrupt', () => {
    expect(parseCopilotPrimaryView({ ...view, snapshot: { ...snapshot, sha256: 'bad' } })).toEqual({
      source: 'tool_result',
      ref: view.ref,
    });
    expect(parseCopilotPrimaryView({ source: 'tool_result', ref: view.ref })).toEqual({
      source: 'tool_result',
      ref: view.ref,
    });
    expect(parseCopilotPrimaryView({ ...view, ref: { kind: '', id: 'call' } })).toBeUndefined();
  });

  it('keeps unavailable a distinct state, never an empty successful result', () => {
    expect(
      CopilotToolResultSnapshotSchema.parse({
        version: 1,
        state: 'unavailable',
        reason: 'internal_only',
      }),
    ).toEqual({ version: 1, state: 'unavailable', reason: 'internal_only' });
    expect(
      CopilotToolResultSnapshotSchema.safeParse({
        version: 1,
        state: 'unavailable',
        reason: 'internal_only',
        value: [],
      }).success,
    ).toBe(false);
  });
});

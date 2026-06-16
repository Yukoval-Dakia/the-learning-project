// YUK-361 Phase 3 Step B — SelectionOrchestratorDraft schema 单测（no DB）。

import { describe, expect, it } from 'vitest';
import {
  SelectionOrchestratorCandidate,
  SelectionOrchestratorDraft,
} from './selection-orchestrator';

describe('SelectionOrchestratorCandidate', () => {
  it('accepts a valid candidate (with optional arrangement)', () => {
    const r = SelectionOrchestratorCandidate.safeParse({
      refId: 'q-1',
      weight: 1.5,
      role: 'diagnostic',
      arrangement: 2,
      reason: 'near-θ̂ diagnostic value high',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a candidate without arrangement (optional)', () => {
    const r = SelectionOrchestratorCandidate.safeParse({
      refId: 'q-1',
      weight: 0,
      role: 'frontier',
      reason: '现在不该练',
    });
    expect(r.success).toBe(true);
  });

  it('accepts weight 0 (legal "not worth practicing now")', () => {
    const r = SelectionOrchestratorCandidate.safeParse({
      refId: 'q-1',
      weight: 0,
      role: 'new_check',
      reason: 'ok',
    });
    expect(r.success).toBe(true);
  });

  it('rejects negative weight', () => {
    const r = SelectionOrchestratorCandidate.safeParse({
      refId: 'q-1',
      weight: -0.1,
      role: 'diagnostic',
      reason: 'bad',
    });
    expect(r.success).toBe(false);
  });

  it('rejects missing refId', () => {
    const r = SelectionOrchestratorCandidate.safeParse({
      weight: 1,
      role: 'diagnostic',
      reason: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty refId', () => {
    const r = SelectionOrchestratorCandidate.safeParse({
      refId: '',
      weight: 1,
      role: 'diagnostic',
      reason: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty reason', () => {
    const r = SelectionOrchestratorCandidate.safeParse({
      refId: 'q-1',
      weight: 1,
      role: 'diagnostic',
      reason: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown role (e.g. due — LLM must not touch due items)', () => {
    const r = SelectionOrchestratorCandidate.safeParse({
      refId: 'q-1',
      weight: 1,
      role: 'due',
      reason: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-integer arrangement', () => {
    const r = SelectionOrchestratorCandidate.safeParse({
      refId: 'q-1',
      weight: 1,
      role: 'diagnostic',
      arrangement: 1.5,
      reason: 'x',
    });
    expect(r.success).toBe(false);
  });
});

describe('SelectionOrchestratorDraft', () => {
  it('accepts a valid draft with multiple candidates', () => {
    const r = SelectionOrchestratorDraft.safeParse({
      candidates: [
        { refId: 'q-1', weight: 2, role: 'diagnostic', reason: 'a' },
        { refId: 'q-2', weight: 0.5, role: 'frontier', arrangement: 1, reason: 'b' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty candidates array (empty stream must not call L2)', () => {
    const r = SelectionOrchestratorDraft.safeParse({ candidates: [] });
    expect(r.success).toBe(false);
  });

  it('rejects a draft whose any candidate has a negative weight', () => {
    const r = SelectionOrchestratorDraft.safeParse({
      candidates: [
        { refId: 'q-1', weight: 1, role: 'diagnostic', reason: 'a' },
        { refId: 'q-2', weight: -1, role: 'frontier', reason: 'b' },
      ],
    });
    expect(r.success).toBe(false);
  });
});

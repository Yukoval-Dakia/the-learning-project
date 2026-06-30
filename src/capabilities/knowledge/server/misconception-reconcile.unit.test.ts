// YUK-531 (A5 S4 / ADR-0036 RT1) — heterogeneous misconception-edge reconcile ring,
// PURE decision layer. No DB, no live caller, no schema (runs in the no-DB unit car
// by the *.unit.test.ts naming convention). Mirrors edge-reconcile.unit.test.ts.

import { ReconcileParseError } from '@/capabilities/knowledge/server/edge-reconcile';
import { describe, expect, it, vi } from 'vitest';
import {
  type MisconceptionEdgeCandidate,
  type MisconceptionEdgeNeighbor,
  applyConfidenceThreshold,
  buildMisconceptionReconcilePrompt,
  judgeMisconceptionReconcile,
  parseMisconceptionReconcileResponse,
} from './misconception-reconcile';

const MOCK_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  ZHIPU_API_KEY: 'test-key',
  DASHSCOPE_API_KEY: 'test-dashscope',
};

function candidate(
  overrides: Partial<MisconceptionEdgeCandidate> = {},
): MisconceptionEdgeCandidate {
  return {
    from_id: 'misc_new',
    to_kind: 'misconception',
    to_id: 'misc_other',
    relation_type: 'confusable_with',
    from_name: 'treats chain rule as product',
    to_name: 'treats chain rule as quotient',
    reasoning: 'the corrected confusion is with the quotient rule',
    ...overrides,
  };
}

function neighbor(overrides: Partial<MisconceptionEdgeNeighbor> = {}): MisconceptionEdgeNeighbor {
  return {
    index: 0,
    edge_id: 'misc-edge-real-uuid-1',
    from_id: 'misc_old',
    to_kind: 'misconception',
    to_id: 'misc_wrong',
    relation_type: 'confusable_with',
    ...overrides,
  };
}

function glmResponse(content: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      ...extra,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('buildMisconceptionReconcilePrompt', () => {
  it('covers ALL misconception relation types with per-relation rules', () => {
    const { user } = buildMisconceptionReconcilePrompt(candidate(), [neighbor()]);
    for (const rel of ['caused_by', 'confusable_with', 'observed_in']) {
      expect(user).toContain(rel);
    }
  });

  it('declares a KEEP_BOTH | SUPERSEDE action space (no MERGE / RETRACT_NEW)', () => {
    const { user } = buildMisconceptionReconcilePrompt(candidate(), [neighbor()]);
    expect(user).toContain('KEEP_BOTH');
    expect(user).toContain('SUPERSEDE');
    expect(user).not.toContain('MERGE');
    expect(user).not.toContain('RETRACT_NEW');
  });

  it('scopes the judge AWAY from the topology gate (handled upstream)', () => {
    const { user } = buildMisconceptionReconcilePrompt(candidate(), [neighbor()]);
    expect(user.toLowerCase()).toMatch(/already handled by a separate gate/);
  });

  it('references neighbors by sequential index — never exposes the real edge UUID', () => {
    const { user } = buildMisconceptionReconcilePrompt(candidate(), [
      neighbor({ index: 0, edge_id: 'misc-edge-real-uuid-1' }),
    ]);
    expect(user).toContain('neighbor_index=0');
    expect(user).not.toContain('misc-edge-real-uuid-1');
  });

  it('RED LINE: never co-emits the two mem0 prompt-hijack phrases', () => {
    const { system, user } = buildMisconceptionReconcilePrompt(candidate(), [neighbor()]);
    const combined = `${system} ${user}`;
    const hasSmartManager = /smart memory manager/i.test(combined);
    const hasCompareRetrieved = /Compare newly retrieved facts/i.test(combined);
    expect(hasSmartManager && hasCompareRetrieved).toBe(false);
  });
});

describe('parseMisconceptionReconcileResponse', () => {
  it('parses a KEEP_BOTH decision (neighbor_index null)', () => {
    const raw = JSON.stringify({
      decision: { action: 'KEEP_BOTH', neighbor_index: null, confidence: 0.9, reason: 'distinct' },
    });
    const d = parseMisconceptionReconcileResponse(raw, [neighbor()]);
    expect(d.action).toBe('KEEP_BOTH');
    expect(d.neighbor_index).toBeNull();
    expect(d.superseded_edge_id).toBeNull();
  });

  it('parses a SUPERSEDE decision and resolves the superseded REAL edge id from the index', () => {
    const raw = JSON.stringify({
      decision: { action: 'SUPERSEDE', neighbor_index: 0, confidence: 0.85, reason: 'correction' },
    });
    const d = parseMisconceptionReconcileResponse(raw, [
      neighbor({ index: 0, edge_id: 'misc-edge-real-uuid-1' }),
    ]);
    expect(d.action).toBe('SUPERSEDE');
    expect(d.neighbor_index).toBe(0);
    expect(d.superseded_edge_id).toBe('misc-edge-real-uuid-1');
  });

  it('throws ReconcileParseError on non-JSON', () => {
    expect(() => parseMisconceptionReconcileResponse('not json', [neighbor()])).toThrow(
      ReconcileParseError,
    );
  });

  it('throws ReconcileParseError on an action outside {KEEP_BOTH, SUPERSEDE}', () => {
    const raw = JSON.stringify({
      decision: { action: 'MERGE', neighbor_index: 0, confidence: 0.9, reason: 'x' },
    });
    expect(() => parseMisconceptionReconcileResponse(raw, [neighbor()])).toThrow(
      ReconcileParseError,
    );
  });

  it('throws ReconcileParseError when SUPERSEDE has a null neighbor_index', () => {
    const raw = JSON.stringify({
      decision: { action: 'SUPERSEDE', neighbor_index: null, confidence: 0.9, reason: 'x' },
    });
    expect(() => parseMisconceptionReconcileResponse(raw, [neighbor()])).toThrow(
      ReconcileParseError,
    );
  });

  it('throws ReconcileParseError when SUPERSEDE names a hallucinated neighbor_index', () => {
    const raw = JSON.stringify({
      decision: { action: 'SUPERSEDE', neighbor_index: 7, confidence: 0.9, reason: 'x' },
    });
    expect(() => parseMisconceptionReconcileResponse(raw, [neighbor({ index: 0 })])).toThrow(
      ReconcileParseError,
    );
  });
});

describe('applyConfidenceThreshold', () => {
  it('downgrades a low-confidence SUPERSEDE to KEEP_BOTH and clears the superseded id', () => {
    const low = applyConfidenceThreshold({
      action: 'SUPERSEDE',
      neighbor_index: 0,
      superseded_edge_id: 'misc-edge-real-uuid-1',
      confidence: 0.3,
      reason: 'shaky',
    });
    expect(low.action).toBe('KEEP_BOTH');
    expect(low.neighbor_index).toBeNull();
    expect(low.superseded_edge_id).toBeNull();
  });

  it('keeps a high-confidence SUPERSEDE intact', () => {
    const high = applyConfidenceThreshold({
      action: 'SUPERSEDE',
      neighbor_index: 0,
      superseded_edge_id: 'misc-edge-real-uuid-1',
      confidence: 0.9,
      reason: 'solid',
    });
    expect(high.action).toBe('SUPERSEDE');
    expect(high.superseded_edge_id).toBe('misc-edge-real-uuid-1');
  });
});

describe('judgeMisconceptionReconcile', () => {
  it('empty neighbors -> KEEP_BOTH WITHOUT a GLM call', async () => {
    const fetchMock = vi.fn();
    const d = await judgeMisconceptionReconcile(candidate(), [], {
      env: MOCK_ENV,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(d.action).toBe('KEEP_BOTH');
    expect(d.superseded_edge_id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a candidate judged a correction of a live edge -> SUPERSEDE carrying the old edge id', async () => {
    const fetchMock = vi.fn(async () =>
      glmResponse({
        decision: { action: 'SUPERSEDE', neighbor_index: 0, confidence: 0.88, reason: 'corrects' },
      }),
    );
    const d = await judgeMisconceptionReconcile(
      candidate(),
      [neighbor({ index: 0, edge_id: 'misc-edge-keep' })],
      { env: MOCK_ENV, fetchImpl: fetchMock as unknown as typeof fetch },
    );
    expect(d.action).toBe('SUPERSEDE');
    expect(d.superseded_edge_id).toBe('misc-edge-keep');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody.response_format).toEqual({ type: 'json_object' });
    expect(sentBody.messages).toHaveLength(2);
  });

  it('a low-confidence SUPERSEDE -> downgraded to KEEP_BOTH', async () => {
    const fetchMock = vi.fn(async () =>
      glmResponse({
        decision: { action: 'SUPERSEDE', neighbor_index: 0, confidence: 0.4, reason: 'shaky' },
      }),
    );
    const d = await judgeMisconceptionReconcile(candidate(), [neighbor()], {
      env: MOCK_ENV,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(d.action).toBe('KEEP_BOTH');
    expect(d.superseded_edge_id).toBeNull();
  });

  it('parse failure surfaces ReconcileParseError so the caller can degrade to KEEP_BOTH', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
          status: 200,
        }),
    );
    await expect(
      judgeMisconceptionReconcile(candidate(), [neighbor()], {
        env: MOCK_ENV,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(ReconcileParseError);
  });

  it('throws RetryableError on a 5xx GLM response', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"error":{"message":"down"}}', { status: 503 }),
    );
    await expect(
      judgeMisconceptionReconcile(candidate(), [neighbor()], {
        env: MOCK_ENV,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/503/);
  });
});

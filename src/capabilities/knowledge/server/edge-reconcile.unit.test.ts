// ADR-0034 §3 — write-time reconciliation ring (knowledge-edge), PURE decision
// layer (increment 1). No DB, no live caller, no schema — runs in the no-DB unit
// car by the *.unit.test.ts naming convention (vitest.shared.ts fastTestInclude
// `src/capabilities/**/*.unit.test.ts`).
//
// Exercises the structural-edge reconcile ring in isolation: the 2-action space
// (KEEP_BOTH | SUPERSEDE), per-relation prompt rules across ALL relation types,
// the superseded-edge-id carry-back, the confidence-threshold downgrade, the
// ReconcileParseError safe-degrade surface, and the mem0 prompt-hijack red line.

import { describe, expect, it, vi } from 'vitest';
import {
  type EdgeCandidate,
  type EdgeNeighbor,
  type EdgeRelationType,
  ReconcileParseError,
  applyConfidenceThreshold,
  buildEdgeReconcilePrompt,
  judgeEdgeReconcile,
  parseEdgeReconcileResponse,
} from './edge-reconcile';

// Minimal env for createMem0Config inside judgeEdgeReconcile.
const MOCK_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  ZHIPU_API_KEY: 'test-key',
  DASHSCOPE_API_KEY: 'test-dashscope',
};

function candidate(overrides: Partial<EdgeCandidate> = {}): EdgeCandidate {
  return {
    from_knowledge_id: 'k-new-from',
    to_knowledge_id: 'k-new-to',
    relation_type: 'prerequisite',
    from_name: 'Limits',
    to_name: 'Derivatives',
    reasoning: 'A is needed before B per the corrected trajectory',
    ...overrides,
  };
}

function neighbor(overrides: Partial<EdgeNeighbor> = {}): EdgeNeighbor {
  return {
    index: 0,
    edge_id: 'edge-real-uuid-1',
    from_knowledge_id: 'k-old-from',
    to_knowledge_id: 'k-old-to',
    relation_type: 'prerequisite',
    from_name: 'Continuity',
    to_name: 'Derivatives',
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

describe('buildEdgeReconcilePrompt', () => {
  it('covers ALL relation types with per-relation rules', () => {
    const { user } = buildEdgeReconcilePrompt(candidate(), [neighbor()]);
    for (const rel of [
      'prerequisite',
      'related_to',
      'contrasts_with',
      'derived_from',
      'applied_in',
    ] as EdgeRelationType[]) {
      expect(user).toContain(rel);
    }
  });

  it('declares a KEEP_BOTH | SUPERSEDE action space (no MERGE / RETRACT_NEW)', () => {
    const { user } = buildEdgeReconcilePrompt(candidate(), [neighbor()]);
    expect(user).toContain('KEEP_BOTH');
    expect(user).toContain('SUPERSEDE');
    // MERGE / RETRACT_NEW are text-memory verbs with no structural analog.
    expect(user).not.toContain('MERGE');
    expect(user).not.toContain('RETRACT_NEW');
  });

  it('scopes the judge AWAY from topology (cycle/direction/transitive handled upstream)', () => {
    const { user } = buildEdgeReconcilePrompt(candidate(), [neighbor()]);
    expect(user.toLowerCase()).toMatch(/already handled by a separate gate/);
  });

  it('references neighbors by sequential index — never exposes the real edge UUID', () => {
    const { user } = buildEdgeReconcilePrompt(candidate(), [
      neighbor({ index: 0, edge_id: 'edge-real-uuid-1' }),
    ]);
    expect(user).toContain('neighbor_index=0');
    expect(user).not.toContain('edge-real-uuid-1');
  });

  it('RED LINE: never co-emits the two mem0 prompt-hijack phrases', () => {
    const { system, user } = buildEdgeReconcilePrompt(candidate(), [neighbor()]);
    const combined = `${system} ${user}`;
    const hasSmartManager = /smart memory manager/i.test(combined);
    const hasCompareRetrieved = /Compare newly retrieved facts/i.test(combined);
    expect(hasSmartManager && hasCompareRetrieved).toBe(false);
  });
});

describe('parseEdgeReconcileResponse', () => {
  it('parses a KEEP_BOTH decision (neighbor_index null)', () => {
    const raw = JSON.stringify({
      decision: { action: 'KEEP_BOTH', neighbor_index: null, confidence: 0.9, reason: 'distinct' },
    });
    const d = parseEdgeReconcileResponse(raw, [neighbor()]);
    expect(d.action).toBe('KEEP_BOTH');
    expect(d.neighbor_index).toBeNull();
    expect(d.superseded_edge_id).toBeNull();
  });

  it('parses a SUPERSEDE decision and resolves the superseded REAL edge id from the index', () => {
    const raw = JSON.stringify({
      decision: { action: 'SUPERSEDE', neighbor_index: 0, confidence: 0.85, reason: 'correction' },
    });
    const d = parseEdgeReconcileResponse(raw, [
      neighbor({ index: 0, edge_id: 'edge-real-uuid-1' }),
    ]);
    expect(d.action).toBe('SUPERSEDE');
    expect(d.neighbor_index).toBe(0);
    expect(d.superseded_edge_id).toBe('edge-real-uuid-1');
  });

  it('throws ReconcileParseError on non-JSON', () => {
    expect(() => parseEdgeReconcileResponse('not json', [neighbor()])).toThrow(ReconcileParseError);
  });

  it('throws ReconcileParseError on a missing decision object', () => {
    expect(() => parseEdgeReconcileResponse('{"foo":"bar"}', [neighbor()])).toThrow(
      ReconcileParseError,
    );
  });

  it('throws ReconcileParseError on an action outside {KEEP_BOTH, SUPERSEDE}', () => {
    const raw = JSON.stringify({
      decision: { action: 'MERGE', neighbor_index: 0, confidence: 0.9, reason: 'x' },
    });
    expect(() => parseEdgeReconcileResponse(raw, [neighbor()])).toThrow(ReconcileParseError);
  });

  it('throws ReconcileParseError when SUPERSEDE has a null neighbor_index', () => {
    const raw = JSON.stringify({
      decision: { action: 'SUPERSEDE', neighbor_index: null, confidence: 0.9, reason: 'x' },
    });
    expect(() => parseEdgeReconcileResponse(raw, [neighbor()])).toThrow(ReconcileParseError);
  });

  it('throws ReconcileParseError when SUPERSEDE names a hallucinated neighbor_index', () => {
    const raw = JSON.stringify({
      decision: { action: 'SUPERSEDE', neighbor_index: 7, confidence: 0.9, reason: 'x' },
    });
    expect(() => parseEdgeReconcileResponse(raw, [neighbor({ index: 0 })])).toThrow(
      ReconcileParseError,
    );
  });
});

describe('applyConfidenceThreshold', () => {
  it('downgrades a low-confidence SUPERSEDE to KEEP_BOTH and clears the superseded id', () => {
    const low = applyConfidenceThreshold({
      action: 'SUPERSEDE',
      neighbor_index: 0,
      superseded_edge_id: 'edge-real-uuid-1',
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
      superseded_edge_id: 'edge-real-uuid-1',
      confidence: 0.9,
      reason: 'solid',
    });
    expect(high.action).toBe('SUPERSEDE');
    expect(high.superseded_edge_id).toBe('edge-real-uuid-1');
  });

  it('uses 0.6 as the default threshold boundary', () => {
    const below = applyConfidenceThreshold({
      action: 'SUPERSEDE',
      neighbor_index: 0,
      superseded_edge_id: 'e',
      confidence: 0.59,
      reason: 'x',
    });
    const above = applyConfidenceThreshold({
      action: 'SUPERSEDE',
      neighbor_index: 0,
      superseded_edge_id: 'e',
      confidence: 0.61,
      reason: 'y',
    });
    expect(below.action).toBe('KEEP_BOTH');
    expect(above.action).toBe('SUPERSEDE');
  });
});

describe('judgeEdgeReconcile', () => {
  it('empty neighbors -> KEEP_BOTH WITHOUT a GLM call', async () => {
    const fetchMock = vi.fn();
    const d = await judgeEdgeReconcile(candidate(), [], {
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
    const d = await judgeEdgeReconcile(
      candidate(),
      [neighbor({ index: 0, edge_id: 'edge-keep' })],
      {
        env: MOCK_ENV,
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    );
    expect(d.action).toBe('SUPERSEDE');
    expect(d.superseded_edge_id).toBe('edge-keep');

    // Verify it hits the coding-plan GLM endpoint with Bearer key + json_object.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/coding/paas/v4/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody.response_format).toEqual({ type: 'json_object' });
    expect(sentBody.messages).toHaveLength(2);
  });

  it('a low-confidence SUPERSEDE -> downgraded to KEEP_BOTH (applyConfidenceThreshold)', async () => {
    const fetchMock = vi.fn(async () =>
      glmResponse({
        decision: { action: 'SUPERSEDE', neighbor_index: 0, confidence: 0.4, reason: 'shaky' },
      }),
    );
    const d = await judgeEdgeReconcile(candidate(), [neighbor()], {
      env: MOCK_ENV,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(d.action).toBe('KEEP_BOTH');
    expect(d.superseded_edge_id).toBeNull();
  });

  it('parse failure surfaces ReconcileParseError so the caller can degrade the batch to KEEP_BOTH', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
          status: 200,
        }),
    );
    await expect(
      judgeEdgeReconcile(candidate(), [neighbor()], {
        env: MOCK_ENV,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(ReconcileParseError);
  });

  it('fires onUsage with token counts on a successful GLM response', async () => {
    const fetchMock = vi.fn(async () =>
      glmResponse(
        { decision: { action: 'KEEP_BOTH', neighbor_index: null, confidence: 0.9, reason: 'ok' } },
        { usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 } },
      ),
    );
    const seen: Array<{ promptTokens: number; completionTokens: number }> = [];
    await judgeEdgeReconcile(candidate(), [neighbor()], {
      env: MOCK_ENV,
      fetchImpl: fetchMock as unknown as typeof fetch,
      onUsage: (u) => seen.push(u),
    });
    expect(seen).toEqual([{ promptTokens: 321, completionTokens: 12 }]);
  });

  it('throws RetryableError on a 5xx GLM response', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"error":{"message":"down"}}', { status: 503 }),
    );
    await expect(
      judgeEdgeReconcile(candidate(), [neighbor()], {
        env: MOCK_ENV,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/503/);
  });
});

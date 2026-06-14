import { describe, expect, it, vi } from 'vitest';
import {
  type CandidateEntry,
  type NewMemoryEntry,
  ReconcileParseError,
  applyConfidenceThreshold,
  buildReconcilePrompt,
  judgeReconciliation,
  parseReconcileResponse,
} from './reconcile-llm';

// Minimal env for createMem0Config inside judgeReconciliation
const MOCK_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  ZHIPU_API_KEY: 'test-key',
  DASHSCOPE_API_KEY: 'test-dashscope',
};

function mockNewMems(): NewMemoryEntry[] {
  return [
    {
      index: 0,
      kind: 'preference',
      text: 'User prefers dark mode',
      memory_id: 'mem-new-1',
      created_ms: 2000,
    },
    {
      index: 1,
      kind: 'event',
      text: 'User answered question q1',
      memory_id: 'mem-new-2',
      created_ms: 2000,
    },
  ];
}

function mockCandidates(): Map<number, CandidateEntry[]> {
  return new Map([
    [
      0,
      [
        { index: 0, text: 'User prefers light mode', memory_id: 'mem-old-1', created_ms: 1000 },
        { index: 1, text: 'User likes terse feedback', memory_id: 'mem-old-2', created_ms: 2000 },
      ],
    ],
    [1, []],
  ]);
}

describe('buildReconcilePrompt', () => {
  it('contains per-kind rules: preference leans SUPERSEDE, event leans KEEP_BOTH', () => {
    const { user } = buildReconcilePrompt(mockNewMems(), mockCandidates());
    // preference / habit → single latest truth (SUPERSEDE / MERGE)
    expect(user).toMatch(/preference or habit.*SUPERSEDE.*MERGE/i);
    // weakness / event → KEEP_BOTH
    expect(user).toMatch(/weakness or event.*KEEP_BOTH/i);
  });

  it('never contains both hijack phrases simultaneously', () => {
    const { system, user } = buildReconcilePrompt(mockNewMems(), mockCandidates());
    const combined = `${system} ${user}`;
    // The red-line: never simultaneously "smart memory manager" AND "Compare newly retrieved facts"
    const hasSmartManager = /smart memory manager/i.test(combined);
    const hasCompareRetrieved = /Compare newly retrieved facts/i.test(combined);
    expect(hasSmartManager && hasCompareRetrieved).toBe(false);
  });

  it('does not expose real UUIDs — uses sequential indices', () => {
    const { user } = buildReconcilePrompt(mockNewMems(), mockCandidates());
    // Should NOT contain mem-old-1 or mem-new-1 (real ids)
    expect(user).not.toContain('mem-old-1');
    expect(user).not.toContain('mem-new-1');
    // Should contain index-based references
    expect(user).toContain('old_index=0');
    expect(user).toContain('new_index=0');
  });
});

describe('parseReconcileResponse', () => {
  it('parses valid JSON with decisions', () => {
    const raw = JSON.stringify({
      decisions: [
        {
          new_index: 0,
          action: 'SUPERSEDE',
          old_index: 0,
          confidence: 0.9,
          reason: 'updated pref',
        },
        {
          new_index: 1,
          action: 'KEEP_BOTH',
          old_index: null,
          confidence: 0.8,
          reason: 'different',
        },
      ],
    });
    const result = parseReconcileResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0].action).toBe('SUPERSEDE');
    expect(result[1].old_index).toBeNull();
  });

  it('throws ReconcileParseError on non-JSON', () => {
    expect(() => parseReconcileResponse('not json')).toThrow(ReconcileParseError);
  });

  it('throws ReconcileParseError on missing decisions array', () => {
    expect(() => parseReconcileResponse('{"foo": "bar"}')).toThrow(ReconcileParseError);
  });

  it('throws ReconcileParseError on invalid action', () => {
    const raw = JSON.stringify({
      decisions: [{ new_index: 0, action: 'INVALID', old_index: null, confidence: 0.5 }],
    });
    expect(() => parseReconcileResponse(raw)).toThrow(ReconcileParseError);
  });

  it('throws ReconcileParseError on empty decisions array', () => {
    const raw = JSON.stringify({ decisions: [] });
    expect(() => parseReconcileResponse(raw)).toThrow(ReconcileParseError);
  });

  it('requires merged_text for MERGE (never lets reason stand in for merged content)', () => {
    const noText = JSON.stringify({
      decisions: [
        { new_index: 0, action: 'MERGE', old_index: 0, confidence: 0.8, reason: 'they overlap' },
      ],
    });
    expect(() => parseReconcileResponse(noText)).toThrow(ReconcileParseError);

    const withText = JSON.stringify({
      decisions: [
        {
          new_index: 0,
          action: 'MERGE',
          old_index: 0,
          confidence: 0.8,
          reason: 'they overlap',
          merged_text: 'User prefers dark mode and terse feedback',
        },
      ],
    });
    expect(parseReconcileResponse(withText)[0].merged_text).toBe(
      'User prefers dark mode and terse feedback',
    );
  });

  it('requires a non-null old_index for SUPERSEDE / MERGE', () => {
    const raw = JSON.stringify({
      decisions: [
        { new_index: 0, action: 'SUPERSEDE', old_index: null, confidence: 0.8, reason: 'x' },
      ],
    });
    expect(() => parseReconcileResponse(raw)).toThrow(ReconcileParseError);
  });

  it('throws on non-integer new_index (LLM hallucination)', () => {
    const raw = JSON.stringify({
      decisions: [
        { new_index: 'oops', action: 'KEEP_BOTH', old_index: null, confidence: 0.9, reason: 'x' },
      ],
    });
    expect(() => parseReconcileResponse(raw)).toThrow(ReconcileParseError);
  });
});

describe('applyConfidenceThreshold', () => {
  it('downgrades low-confidence destructive actions to KEEP_BOTH', () => {
    const decisions = [
      { new_index: 0, action: 'SUPERSEDE' as const, old_index: 0, confidence: 0.3, reason: 'low' },
      {
        new_index: 1,
        action: 'KEEP_BOTH' as const,
        old_index: null,
        confidence: 0.2,
        reason: 'already keep',
      },
      { new_index: 2, action: 'MERGE' as const, old_index: 1, confidence: 0.9, reason: 'high' },
    ];
    const result = applyConfidenceThreshold(decisions);
    expect(result[0].action).toBe('KEEP_BOTH'); // downgraded
    expect(result[0].old_index).toBeNull(); // cleared
    expect(result[1].action).toBe('KEEP_BOTH'); // unchanged
    expect(result[2].action).toBe('MERGE'); // unchanged (above threshold)
  });

  it('uses 0.6 as default threshold', () => {
    const decisions = [
      { new_index: 0, action: 'SUPERSEDE' as const, old_index: 0, confidence: 0.59, reason: 'x' },
      { new_index: 1, action: 'SUPERSEDE' as const, old_index: 0, confidence: 0.61, reason: 'y' },
    ];
    const result = applyConfidenceThreshold(decisions);
    expect(result[0].action).toBe('KEEP_BOTH'); // below 0.6
    expect(result[1].action).toBe('SUPERSEDE'); // above 0.6
  });
});

describe('judgeReconciliation', () => {
  it('calls GLM /chat/completions with coding-plan baseURL and Bearer key', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    decisions: [
                      {
                        new_index: 0,
                        action: 'KEEP_BOTH',
                        old_index: null,
                        confidence: 0.9,
                        reason: 'ok',
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );

    const decisions = await judgeReconciliation(mockNewMems(), mockCandidates(), {
      env: MOCK_ENV,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // Must use coding-plan endpoint (/api/coding/paas/v4), not standard /api/paas/v4
    expect(String(url)).toContain('/api/coding/paas/v4/chat/completions');
    expect(String(url)).not.toContain('/api/paas/v4/');

    const opts = init;
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');

    const body = JSON.parse(String(opts.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toHaveLength(2); // system + user

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('KEEP_BOTH');
  });

  it('throws RetryableError on 5xx', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"error":{"message":"down"}}', { status: 503 }),
    );

    await expect(
      judgeReconciliation(mockNewMems(), mockCandidates(), {
        env: MOCK_ENV,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/503/);
  });

  it('throws ReconcileParseError when GLM returns non-JSON content', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
          status: 200,
        }),
    );

    await expect(
      judgeReconciliation(mockNewMems(), mockCandidates(), {
        env: MOCK_ENV,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(ReconcileParseError);
  });
});

import type {
  DirectProviderLifecycleFactory,
  DirectProviderOperationContext,
} from '@/server/ai/direct-provider-attempt';
import { describe, expect, it, vi } from 'vitest';
import {
  type CandidateEntry,
  MERGE_RETRACT_SCORE_FLOOR,
  type NewMemoryEntry,
  ReconcileParseError,
  applyConfidenceThreshold,
  buildReconcilePrompt,
  judgeReconciliation,
  kindForbidsMerge,
  parseReconcileResponse,
  passesStructuralCorroboration,
} from './reconcile-llm';

// Minimal env for createMem0Config inside judgeReconciliation
const MOCK_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  ZHIPU_API_KEY: 'test-key',
  DASHSCOPE_API_KEY: 'test-dashscope',
};

function attemptContext(
  records: unknown[],
  externalRequestIds: string[] = [],
): DirectProviderOperationContext {
  const createLifecycle: DirectProviderLifecycleFactory = (input) => ({
    identity: input.identity,
    acquire: async () => ({
      admission: 'acquired',
      reserveProviderStart: async () => undefined,
      recordExternalRequestId: async (id) => {
        externalRequestIds.push(id);
      },
      finish: async (evidence) => {
        records.push({ identity: input.identity, evidence });
        return 'settled';
      },
    }),
  });
  return {
    caller: 'worker',
    deadlineAt: new Date('2030-01-01T00:00:00.000Z'),
    mode: 'observe',
    operationId: '00000000-0000-4000-8000-000000000020',
    createLifecycle,
  };
}

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
        // YUK-557: candidates now carry mem0's fused `score` — must not leak into
        // the prompt (indices only) nor break parsing.
        {
          index: 0,
          text: 'User prefers light mode',
          memory_id: 'mem-old-1',
          created_ms: 1000,
          score: 0.77,
        },
        {
          index: 1,
          text: 'User likes terse feedback',
          memory_id: 'mem-old-2',
          created_ms: 2000,
          score: 0.34,
        },
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
      providerAttempt: attemptContext([]),
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

  it('records attempt cost truth when billed content is empty before parse failure', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '' } }],
            usage: { prompt_tokens: 800, completion_tokens: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const attempts: unknown[] = [];

    await expect(
      judgeReconciliation(mockNewMems(), mockCandidates(), {
        env: MOCK_ENV,
        fetchImpl: fetchMock as unknown as typeof fetch,
        providerAttempt: attemptContext(attempts),
      }),
    ).rejects.toThrow(ReconcileParseError);

    expect(attempts).toEqual([
      expect.objectContaining({
        evidence: expect.objectContaining({
          terminal: 'failed',
          reason: 'provider_response_malformed',
          wireCount: 1,
          usage: expect.objectContaining({
            basis: 'reported',
            input: 800,
            output: 0,
          }),
          cost: expect.objectContaining({
            basis: 'estimated',
            amount: expect.any(Number),
            currency: 'CNY',
            source: 'glm-chat-pricebook',
          }),
        }),
      }),
    ]);
  });

  it('keeps partial provider usage null while estimating from the reported token subset', async () => {
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
            usage: { prompt_tokens: 17 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const attempts: unknown[] = [];
    await judgeReconciliation(mockNewMems(), mockCandidates(), {
      env: MOCK_ENV,
      fetchImpl: fetchMock as unknown as typeof fetch,
      providerAttempt: attemptContext(attempts),
    });

    expect(attempts).toEqual([
      expect.objectContaining({
        evidence: expect.objectContaining({
          usage: expect.objectContaining({ input: 17, output: null, total: null }),
          cost: expect.objectContaining({ basis: 'estimated', amount: expect.any(Number) }),
        }),
      }),
    ]);
  });

  it('leaves provider usage and cost unknown for an empty usage object', async () => {
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
            usage: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const attempts: unknown[] = [];
    await judgeReconciliation(mockNewMems(), mockCandidates(), {
      env: MOCK_ENV,
      fetchImpl: fetchMock as unknown as typeof fetch,
      providerAttempt: attemptContext(attempts),
    });

    expect(attempts).toEqual([
      expect.objectContaining({
        evidence: expect.objectContaining({
          usage: expect.objectContaining({ basis: 'unknown', input: null, output: null }),
        }),
      }),
    ]);
  });

  it('throws RetryableError on 5xx', async () => {
    const externalRequestIds: string[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response('{"id":"glm-memory-error-503","error":{"message":"down"}}', {
          status: 503,
        }),
    );

    await expect(
      judgeReconciliation(mockNewMems(), mockCandidates(), {
        env: MOCK_ENV,
        fetchImpl: fetchMock as unknown as typeof fetch,
        providerAttempt: attemptContext([], externalRequestIds),
      }),
    ).rejects.toThrow(/503/);
    expect(externalRequestIds).toEqual(['glm-memory-error-503']);
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
        providerAttempt: attemptContext([]),
      }),
    ).rejects.toThrow(ReconcileParseError);
  });
});

// YUK-557 (Q1) — second, non-LLM structural corroboration gate.
describe('passesStructuralCorroboration (Q1 score floor)', () => {
  it('MERGE/RETRACT_NEW below floor → false (four-quadrant: destructive × below)', () => {
    const below = MERGE_RETRACT_SCORE_FLOOR - 0.1;
    expect(passesStructuralCorroboration('MERGE', below)).toBe(false);
    expect(passesStructuralCorroboration('RETRACT_NEW', below)).toBe(false);
  });

  it('MERGE/RETRACT_NEW at/above floor → true (destructive × at-or-above)', () => {
    expect(passesStructuralCorroboration('MERGE', MERGE_RETRACT_SCORE_FLOOR)).toBe(true);
    expect(passesStructuralCorroboration('RETRACT_NEW', MERGE_RETRACT_SCORE_FLOOR + 0.3)).toBe(
      true,
    );
  });

  it('SUPERSEDE/KEEP_BOTH are exempt → always true even below floor (non-destructive × below)', () => {
    const below = MERGE_RETRACT_SCORE_FLOOR - 0.4;
    expect(passesStructuralCorroboration('SUPERSEDE', below)).toBe(true);
    expect(passesStructuralCorroboration('KEEP_BOTH', below)).toBe(true);
  });

  it('score===undefined → gate abstains (returns true) for every action (undefined × any)', () => {
    expect(passesStructuralCorroboration('MERGE', undefined)).toBe(true);
    expect(passesStructuralCorroboration('RETRACT_NEW', undefined)).toBe(true);
    expect(passesStructuralCorroboration('SUPERSEDE', undefined)).toBe(true);
    expect(passesStructuralCorroboration('KEEP_BOTH', undefined)).toBe(true);
  });
});

describe('kindForbidsMerge (Q1b per-kind execution gate)', () => {
  it('weakness / event forbid MERGE (mistake/error trajectory history)', () => {
    expect(kindForbidsMerge('weakness')).toBe(true);
    expect(kindForbidsMerge('event')).toBe(true);
  });

  it('preference / habit do not forbid MERGE (single-latest-truth kinds)', () => {
    expect(kindForbidsMerge('preference')).toBe(false);
    expect(kindForbidsMerge('habit')).toBe(false);
  });

  it('unknown kind does not forbid MERGE (only the two named kinds are guarded)', () => {
    expect(kindForbidsMerge('anything-else')).toBe(false);
    expect(kindForbidsMerge('')).toBe(false);
  });
});

describe('CandidateEntry.score does not break prompt build or parse', () => {
  it('scored candidates never leak score/uuid into the prompt (indices only)', () => {
    const { user } = buildReconcilePrompt(mockNewMems(), mockCandidates());
    // Scores present on the candidates must NOT appear in the LLM-facing prompt
    // (values chosen to not collide with the prompt's example confidence literals).
    expect(user).not.toContain('0.77');
    expect(user).not.toContain('0.34');
    expect(user).not.toContain('mem-old-1');
    expect(user).toContain('old_index=0');
  });

  it('parseReconcileResponse is unaffected by candidate scores (parse is over decisions)', () => {
    const raw = JSON.stringify({
      decisions: [
        { new_index: 0, action: 'KEEP_BOTH', old_index: null, confidence: 0.9, reason: 'ok' },
      ],
    });
    expect(parseReconcileResponse(raw)).toHaveLength(1);
  });
});

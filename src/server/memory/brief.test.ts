import { LONG_TERM_FRESHNESS_BUDGET } from '@/server/ai/tools/budgets';
import { describe, expect, it, vi } from 'vitest';
import {
  BRIEF_TEMPLATES,
  type BriefRow,
  regenerateMemoryBrief,
  resolveEvidenceTimestamps,
} from './brief';
import { scoreLongTermFreshness } from './brief-freshness';

const NOW = new Date('2026-05-31T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('BRIEF_TEMPLATES', () => {
  it('defines one template for each ADR-0017 scope prefix', () => {
    expect(Object.keys(BRIEF_TEMPLATES).sort()).toEqual([
      'global',
      'meta:orchestrator_self',
      'mistake_cluster',
      'subject',
      'topic',
    ]);
  });
});

describe('regenerateMemoryBrief', () => {
  it('builds a scoped prompt, calls injected LLM once, and upserts one brief row', async () => {
    const generate = vi.fn(async () => ({
      recent_week_md: '## Recent week\n- Still misses punctuation particles.',
      recent_months_md: '## Recent months\n- Improving on function words.',
      long_term_md: '## Long term\n- Responds well to contrastive examples.',
      recent_week_evidence_ids: ['evt_1'],
      recent_months_evidence_ids: ['evt_1', 'evt_2'],
      long_term_evidence_ids: ['evt_0'],
    }));
    const upsertBrief = vi.fn(async () => undefined);

    const result = await regenerateMemoryBrief({
      scopeKey: 'topic:k-particles',
      loadEvents: async () => [
        {
          id: 'evt_1',
          action: 'attempt',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'failure',
          payload: { answer_md: 'wrong' },
          created_at: new Date('2026-05-27T01:00:00Z'),
        },
      ],
      searchFacts: async () => [{ id: 'mem_1', memory: 'Often confuses particles.' }],
      generate,
      upsertBrief,
      now: () => new Date('2026-05-27T02:00:00Z'),
    });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'topic:k-particles',
        template: BRIEF_TEMPLATES.topic,
        facts: [{ id: 'mem_1', memory: 'Often confuses particles.' }],
      }),
    );
    expect(upsertBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_key: 'topic:k-particles',
        latest_evidence_at: new Date('2026-05-27T01:00:00Z'),
        evidence_count: 1,
        refreshed_at: new Date('2026-05-27T02:00:00Z'),
      }),
    );
    expect(result.wrote).toBe(true);
  });
});

// ── P5.3 (YUK-183) — long-term brief freshness score ────────────────────────

describe('scoreLongTermFreshness', () => {
  it('returns null for empty ids (knownCount 0, unjudgeable not scored 0)', () => {
    const r = scoreLongTermFreshness([], NOW, LONG_TERM_FRESHNESS_BUDGET);
    expect(r).toEqual({ score: null, knownCount: 0, unknownCount: 0 });
  });

  it('scores ≈1 when all evidence is fresh (today)', () => {
    const r = scoreLongTermFreshness(
      [
        { id: 'a', created_at: daysAgo(0) },
        { id: 'b', created_at: daysAgo(0) },
      ],
      NOW,
      LONG_TERM_FRESHNESS_BUDGET,
    );
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.knownCount).toBe(2);
  });

  it('scores exactly 0.5 for a single evidence at the half-life (60d)', () => {
    const r = scoreLongTermFreshness(
      [{ id: 'a', created_at: daysAgo(60) }],
      NOW,
      LONG_TERM_FRESHNESS_BUDGET,
    );
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.knownCount).toBe(1);
  });

  it('scores ≈0.3 (advisory boundary) for a single evidence ≈104d old', () => {
    // 0.3 = exp(-ln2 * d / 60)  ⇒  d = 60 * log2(1/0.3) ≈ 104.2d
    const days = 60 * Math.log2(1 / LONG_TERM_FRESHNESS_BUDGET.freshnessThreshold);
    const r = scoreLongTermFreshness(
      [{ id: 'a', created_at: daysAgo(days) }],
      NOW,
      LONG_TERM_FRESHNESS_BUDGET,
    );
    expect(r.score).toBeCloseTo(0.3, 5);
  });

  it('scores ≈0 when all evidence is very old', () => {
    const r = scoreLongTermFreshness(
      [
        { id: 'a', created_at: daysAgo(3650) },
        { id: 'b', created_at: daysAgo(2000) },
      ],
      NOW,
      LONG_TERM_FRESHNESS_BUDGET,
    );
    expect(r.score).not.toBeNull();
    expect(r.score as number).toBeLessThan(0.001);
    expect(r.knownCount).toBe(2);
  });

  it('excludes unknown timestamps from BOTH numerator and knownCount (mixed)', () => {
    // one fresh known + one unknown ⇒ numerator = exp(0)=1, knownCount=1 ⇒ score 1
    const r = scoreLongTermFreshness(
      [
        { id: 'a', created_at: daysAgo(0) },
        { id: 'b', created_at: null },
      ],
      NOW,
      LONG_TERM_FRESHNESS_BUDGET,
    );
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.knownCount).toBe(1);
    expect(r.unknownCount).toBe(1);
  });

  it('returns null when ids are non-empty but ALL unknown (fail-safe, not 0)', () => {
    const r = scoreLongTermFreshness(
      [
        { id: 'a', created_at: null },
        { id: 'b', created_at: null },
      ],
      NOW,
      LONG_TERM_FRESHNESS_BUDGET,
    );
    expect(r.score).toBeNull();
    expect(r.knownCount).toBe(0);
    expect(r.unknownCount).toBe(2);
  });

  it('floors ageDays at 0 for a future timestamp (term = 1, never > 1)', () => {
    const r = scoreLongTermFreshness(
      [{ id: 'a', created_at: new Date(NOW.getTime() + 5 * 86_400_000) }],
      NOW,
      LONG_TERM_FRESHNESS_BUDGET,
    );
    expect(r.score).toBeCloseTo(1, 5);
  });

  it('throws on a non-positive or NaN halfLifeDays (PR #229 guard)', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(() =>
        scoreLongTermFreshness([{ id: 'a', created_at: NOW }], NOW, {
          halfLifeDays: bad,
          freshnessThreshold: 0.3,
        }),
      ).toThrow(/halfLifeDays must be > 0/);
    }
  });
});

describe('resolveEvidenceTimestamps', () => {
  const events = [
    {
      id: 'evt_1',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {},
      created_at: daysAgo(1),
    },
    {
      id: 'evt_2',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q2',
      outcome: 'success',
      payload: {},
      created_at: daysAgo(2),
    },
  ];

  it('does NOT call the loader when every id is present in events', async () => {
    const loadEventTimestamps = vi.fn(async () => []);
    const out = await resolveEvidenceTimestamps(['evt_1', 'evt_2'], events, {
      loadEventTimestamps,
    });
    expect(loadEventTimestamps).not.toHaveBeenCalled();
    expect(out).toEqual([
      { id: 'evt_1', created_at: daysAgo(1) },
      { id: 'evt_2', created_at: daysAgo(2) },
    ]);
  });

  it('calls the loader ONCE with exactly the missing id set (batched)', async () => {
    const loadEventTimestamps = vi.fn(async () => [{ id: 'evt_9', created_at: daysAgo(9) }]);
    const out = await resolveEvidenceTimestamps(['evt_1', 'evt_9'], events, {
      loadEventTimestamps,
    });
    expect(loadEventTimestamps).toHaveBeenCalledTimes(1);
    expect(loadEventTimestamps).toHaveBeenCalledWith(['evt_9']);
    expect(out).toEqual([
      { id: 'evt_1', created_at: daysAgo(1) },
      { id: 'evt_9', created_at: daysAgo(9) },
    ]);
  });

  it('resolves a still-missing id (loader returned nothing for it) to null', async () => {
    const loadEventTimestamps = vi.fn(async () => []);
    const out = await resolveEvidenceTimestamps(['evt_404'], [], { loadEventTimestamps });
    expect(out).toEqual([{ id: 'evt_404', created_at: null }]);
  });

  it('does NOT crash with no db and no loader and missing ids (crash-fix §4.3)', async () => {
    const out = await resolveEvidenceTimestamps(['evt_missing'], events, {});
    expect(out).toEqual([{ id: 'evt_missing', created_at: null }]);
  });
});

describe('regenerateMemoryBrief — P5.3 score persistence (no mutation)', () => {
  it('writes a low score for old evidence WITHOUT mutating long_term_md / long_term_evidence_ids', async () => {
    const draft = {
      recent_week_md: '## Recent week',
      recent_months_md: '## Recent months',
      long_term_md: '## Long term\n- Responds well to contrastive examples.',
      recent_week_evidence_ids: ['evt_lt'],
      recent_months_evidence_ids: ['evt_lt'],
      long_term_evidence_ids: ['evt_lt'],
    };
    const generate = vi.fn(async () => draft);
    const upsertBrief = vi.fn<(row: BriefRow) => Promise<void>>(async () => undefined);
    // evt_lt is NOT in the loaded events window → resolved via the injected seam.
    const loadEventTimestamps = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, created_at: daysAgo(200) })),
    );

    await regenerateMemoryBrief({
      scopeKey: 'subject:wenyan',
      loadEvents: async () => [
        {
          id: 'evt_recent',
          action: 'attempt',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'success',
          payload: {},
          created_at: daysAgo(0),
        },
      ],
      searchFacts: async () => [],
      generate,
      upsertBrief,
      loadEventTimestamps,
      now: () => NOW,
    });

    expect(loadEventTimestamps).toHaveBeenCalledTimes(1);
    expect(loadEventTimestamps).toHaveBeenCalledWith(['evt_lt']);
    const row = upsertBrief.mock.calls[0][0];
    // 200d old with 60d half-life ⇒ well under the 0.3 advisory threshold.
    expect(row.long_term_freshness_score).not.toBeNull();
    expect(row.long_term_freshness_score as number).toBeLessThan(
      LONG_TERM_FRESHNESS_BUDGET.freshnessThreshold,
    );
    // Critical reframe: the paragraph + evidence ids pass through verbatim.
    expect(row.long_term_md).toBe(draft.long_term_md);
    expect(row.long_term_evidence_ids).toEqual(draft.long_term_evidence_ids);
  });

  it('computes/stores the score for meta:orchestrator_self too (no demotion)', async () => {
    const draft = {
      recent_week_md: '',
      recent_months_md: '',
      long_term_md: '## How-to\n- Prefer terse correction.',
      recent_week_evidence_ids: [],
      recent_months_evidence_ids: [],
      long_term_evidence_ids: ['evt_proc'],
    };
    const upsertBrief = vi.fn<(row: BriefRow) => Promise<void>>(async () => undefined);
    await regenerateMemoryBrief({
      scopeKey: 'meta:orchestrator_self',
      loadEvents: async () => [],
      searchFacts: async () => [],
      generate: vi.fn(async () => draft),
      upsertBrief,
      loadEventTimestamps: async (ids: string[]) =>
        ids.map((id) => ({ id, created_at: daysAgo(300) })),
      now: () => NOW,
    });
    const row = upsertBrief.mock.calls[0][0];
    expect(row.long_term_freshness_score).not.toBeNull();
    expect(row.long_term_md).toBe(draft.long_term_md);
  });

  it('de-dups the scoring evidence ids before resolving/scoring (PR #229)', async () => {
    const draft = {
      recent_week_md: '',
      recent_months_md: '',
      long_term_md: '## Long term',
      recent_week_evidence_ids: [],
      recent_months_evidence_ids: [],
      long_term_evidence_ids: ['evt_dup', 'evt_dup', 'evt_other'], // duplicate id
    };
    const upsertBrief = vi.fn<(row: BriefRow) => Promise<void>>(async () => undefined);
    const loadEventTimestamps = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, created_at: daysAgo(10) })),
    );
    await regenerateMemoryBrief({
      scopeKey: 'subject:wenyan',
      loadEvents: async () => [], // empty window ⇒ all ids "missing" ⇒ routed to the loader
      searchFacts: async () => [],
      generate: vi.fn(async () => draft),
      upsertBrief,
      loadEventTimestamps,
      now: () => NOW,
    });
    // The loader (and the score numerator) sees the DEDUPED set, not the raw 3.
    expect(loadEventTimestamps).toHaveBeenCalledTimes(1);
    expect(loadEventTimestamps).toHaveBeenCalledWith(['evt_dup', 'evt_other']);
    // Stored evidence ids are still the verbatim draft (dedup is scoring-only).
    expect(upsertBrief.mock.calls[0][0].long_term_evidence_ids).toEqual(
      draft.long_term_evidence_ids,
    );
  });
});

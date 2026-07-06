import { describe, expect, it, vi } from 'vitest';

import { LEARNER_STATE_HEADER_BUDGET, PROPOSAL_FEEDBACK_BUDGET } from '@/server/ai/tools/budgets';
import type { ProposalFeedbackCell } from '@/server/proposals/adaptive-bias';
import {
  type LearnerStateHeaderCache,
  type LearnerStateProjection,
  type LearnerStateWatermarks,
  type PersistedLearnerStateHeaderCache,
  assembleLearnerStateHeaderMd,
  dayBucket,
  isLearnerStateHeaderStale,
  resolveLearnerStateHeader,
  scopeCopilotProposalFeedback,
} from './learner-state';

// YUK-574 — the learner-state header is a deterministic (no-LLM) code-read
// projection assembled ONCE per validity window (owner hard constraint: never
// per-turn 装配注入) and cached session-anchored. These unit tests pin the two
// pure predicates (invalidation + size-budget truncation) and the resolver
// orchestration (assemble-once + invalidate-on-trigger) with injected sub-seams
// so the {}-stub db is never touched.

const WM = (over: Partial<LearnerStateWatermarks> = {}): LearnerStateWatermarks => ({
  attempt_at: null,
  dreaming_at: null,
  proposal_decision_at: null,
  ...over,
});

const PROJECTION = (over: Partial<LearnerStateProjection> = {}): LearnerStateProjection => ({
  reviewDueCount: 0,
  activeGoalTitle: null,
  topCauseCategories: [],
  masterySummary: null,
  meanTheta: null,
  overnightSentence: null,
  ...over,
});

// Review-verdict fix #2 (MINOR) — the house cron domain runs Asia/Shanghai; a UTC
// day bucket fires cross-day invalidation at Beijing 08:00, not midnight. bucket
// by Asia/Shanghai calendar day instead.
describe('dayBucket', () => {
  it('buckets by Asia/Shanghai calendar day (YYYY-MM-DD), NOT UTC', () => {
    // Beijing 2026-07-06 23:59:59 = UTC 2026-07-06 15:59:59 (still the same BJT day).
    expect(dayBucket(new Date('2026-07-06T15:59:59.000Z'))).toBe('2026-07-06');
    // Beijing 2026-07-07 00:00:00 = UTC 2026-07-06 16:00:00 (BJT day just rolled over).
    expect(dayBucket(new Date('2026-07-06T16:00:00.000Z'))).toBe('2026-07-07');
  });

  it('cross-day boundary: Beijing 00:30 (UTC previous-day 16:30) is judged a NEW day', () => {
    // Beijing 2026-07-06 00:30:00 = UTC 2026-07-05 16:30:00.
    expect(dayBucket(new Date('2026-07-05T16:30:00.000Z'))).toBe('2026-07-06');
    // The UTC calendar day at that instant is STILL 2026-07-05 — proving this is
    // genuinely Asia/Shanghai-bucketed, not accidentally UTC-equivalent.
    expect(new Date('2026-07-05T16:30:00.000Z').toISOString().slice(0, 10)).toBe('2026-07-05');
  });
});

describe('isLearnerStateHeaderStale', () => {
  const base = {
    day_bucket: '2026-07-06',
    watermarks: WM({
      attempt_at: '2026-07-06T08:00:00.000Z',
      dreaming_at: '2026-07-06T03:00:00.000Z',
      proposal_decision_at: '2026-07-06T07:00:00.000Z',
    }),
  };

  it('is fresh when the day and every watermark are unchanged', () => {
    expect(isLearnerStateHeaderStale(base, { ...base })).toBe(false);
  });

  it('stales on a cross-day boundary', () => {
    expect(isLearnerStateHeaderStale(base, { ...base, day_bucket: '2026-07-07' })).toBe(true);
  });

  it('stales when a new attempt event arrives', () => {
    expect(
      isLearnerStateHeaderStale(base, {
        day_bucket: base.day_bucket,
        watermarks: WM({ ...base.watermarks, attempt_at: '2026-07-06T09:30:00.000Z' }),
      }),
    ).toBe(true);
  });

  it('stales when dreaming ran overnight (dreaming watermark advanced)', () => {
    expect(
      isLearnerStateHeaderStale(base, {
        day_bucket: base.day_bucket,
        watermarks: WM({ ...base.watermarks, dreaming_at: '2026-07-06T03:30:00.000Z' }),
      }),
    ).toBe(true);
  });

  it('stales when a proposal decision (accept/dismiss) landed', () => {
    expect(
      isLearnerStateHeaderStale(base, {
        day_bucket: base.day_bucket,
        watermarks: WM({ ...base.watermarks, proposal_decision_at: '2026-07-06T07:15:00.000Z' }),
      }),
    ).toBe(true);
  });

  it('stales when a previously-empty watermark becomes populated', () => {
    const coldCache = { day_bucket: '2026-07-06', watermarks: WM() };
    expect(
      isLearnerStateHeaderStale(coldCache, {
        day_bucket: '2026-07-06',
        watermarks: WM({ attempt_at: '2026-07-06T08:00:00.000Z' }),
      }),
    ).toBe(true);
  });

  it('does not stale merely because a watermark went from set to null (events never vanish)', () => {
    expect(
      isLearnerStateHeaderStale(base, {
        day_bucket: base.day_bucket,
        watermarks: WM({ ...base.watermarks, attempt_at: null }),
      }),
    ).toBe(false);
  });
});

describe('assembleLearnerStateHeaderMd', () => {
  it('renders due count, active goal, top-2 误区, mastery band, and 昨夜交班', () => {
    const md = assembleLearnerStateHeaderMd(
      PROJECTION({
        reviewDueCount: 7,
        activeGoalTitle: '掌握虚词「之」的六种用法',
        topCauseCategories: ['句读断错', '词义混淆'],
        masterySummary: '精熟2 稳固3 成长1',
        meanTheta: 0.42,
        overnightSentence: '昨晚整理了「之」的宾语前置线索，今天先过复习队列。',
      }),
    );
    expect(md).toContain('7');
    expect(md).toContain('掌握虚词「之」的六种用法');
    expect(md).toContain('句读断错');
    expect(md).toContain('词义混淆');
    expect(md).toContain('精熟2 稳固3 成长1');
    expect(md).toContain('昨晚整理了');
  });

  it('omits absent lines on cold start (no goal / no mistakes / no mastery / no handoff)', () => {
    const md = assembleLearnerStateHeaderMd(PROJECTION({ reviewDueCount: 0 }));
    // Due line is always present; the optional lines are absent, not rendered blank.
    expect(md).not.toContain('当前目标');
    expect(md).not.toContain('近期');
    expect(md).not.toContain('掌握度');
    expect(md).not.toContain('昨夜');
  });

  it('hard-truncates to the size budget', () => {
    const md = assembleLearnerStateHeaderMd(
      PROJECTION({
        reviewDueCount: 3,
        activeGoalTitle: '目标'.repeat(400),
        overnightSentence: '摘要'.repeat(400),
      }),
    );
    expect(md.length).toBeLessThanOrEqual(LEARNER_STATE_HEADER_BUDGET.maxChars);
  });
});

describe('scopeCopilotProposalFeedback', () => {
  it('keeps only knowledge_edge cells and drops the non-edge accounting fields', () => {
    const digest: ProposalFeedbackCell[] = [
      {
        kind: 'knowledge_edge',
        relation: 'related_to',
        accept_count: 1,
        dismiss_count: 9,
        total: 10,
        acceptance_rate: 0.1,
        top_dismiss_reasons: ['dumping ground'],
        top_rubric_gates: ['related_to_dumping_ground'],
      },
      {
        kind: 'completion',
        relation: null,
        accept_count: 0,
        dismiss_count: 3,
        total: 3,
        acceptance_rate: 0,
        top_dismiss_reasons: ['too early'],
        top_rubric_gates: [],
      },
    ];
    expect(scopeCopilotProposalFeedback(digest)).toEqual([
      {
        kind: 'knowledge_edge',
        relation: 'related_to',
        acceptance_rate: 0.1,
        top_dismiss_reasons: ['dumping ground'],
        top_rubric_gates: ['related_to_dumping_ground'],
      },
    ]);
  });

  // P5.4-L2 / YUK-174 (P1 fix), migrated from chat.unit.test.ts — a realistic
  // multi-cell digest must NOT collapse to [] (per-string maxChars is NOT the
  // whole-digest cap), and reason-bearing (actionable, low-acceptance) cells must
  // be kept AHEAD of reason-less ones so whole-digest truncation preserves them.
  it('keeps reason-bearing cells (no collapse) and orders them first, still whole-digest bounded', () => {
    const mkCell = (
      relation: string,
      rate: number,
      reasons: string[],
      gates: string[],
    ): ProposalFeedbackCell => ({
      kind: 'knowledge_edge',
      relation,
      accept_count: Math.round(rate * 10),
      dismiss_count: 10 - Math.round(rate * 10),
      total: 10,
      acceptance_rate: rate,
      top_dismiss_reasons: reasons,
      top_rubric_gates: gates,
    });
    const scoped = scopeCopilotProposalFeedback([
      mkCell('derived_from', 0.9, [], []),
      mkCell('prerequisite', 0.8, [], []),
      mkCell(
        'related_to',
        0.1,
        ['dumping ground; too vague to be useful'],
        ['related_to_dumping_ground'],
      ),
      mkCell(
        'applied_in',
        0.2,
        ['not actually applied here'],
        ['applied_in_no_application_evidence'],
      ),
    ]);
    expect(scoped.length).toBeGreaterThan(0);
    const relations = scoped.map((c) => c.relation);
    expect(relations).toContain('related_to');
    expect(relations).toContain('applied_in');
    const lastActionable = Math.max(
      relations.indexOf('related_to'),
      relations.indexOf('applied_in'),
    );
    const firstReasonless = relations.findIndex(
      (r) => r === 'derived_from' || r === 'prerequisite',
    );
    if (firstReasonless !== -1) expect(lastActionable).toBeLessThan(firstReasonless);
    expect(JSON.stringify(scoped).length).toBeLessThanOrEqual(
      PROPOSAL_FEEDBACK_BUDGET.maxSerializedChars,
    );
  });
});

describe('resolveLearnerStateHeader (assemble-once + invalidation)', () => {
  const now = () => new Date('2026-07-06T09:00:00.000Z');
  const rawFeedback: ProposalFeedbackCell[] = [
    {
      kind: 'knowledge_edge',
      relation: 'prerequisite',
      accept_count: 2,
      dismiss_count: 1,
      total: 3,
      acceptance_rate: 0.67,
      top_dismiss_reasons: [],
      top_rubric_gates: [],
    },
  ];

  it('cold cache: assembles, persists a cache row, returns the fresh header + scoped feedback', async () => {
    const readCacheFn = vi.fn(async () => null);
    const readWatermarksFn = vi.fn(async () => WM({ attempt_at: '2026-07-06T08:00:00.000Z' }));
    const readProjectionFn = vi.fn(async () => PROJECTION({ reviewDueCount: 5 }));
    const loadProposalFeedbackFn = vi.fn(async () => rawFeedback);
    const writeCacheFn = vi.fn(
      async (_db: unknown, _cache: PersistedLearnerStateHeaderCache) => {},
    );

    const header = await resolveLearnerStateHeader({} as never, 'ls_1', {
      readCacheFn,
      readWatermarksFn,
      readProjectionFn,
      loadProposalFeedbackFn,
      writeCacheFn,
      now,
    });

    expect(readProjectionFn).toHaveBeenCalledTimes(1);
    expect(writeCacheFn).toHaveBeenCalledTimes(1);
    expect(header.header_md).toContain('5');
    expect(header.proposal_feedback).toEqual(scopeCopilotProposalFeedback(rawFeedback));
    // The persisted cache carries the assembly-time watermarks + day bucket.
    const persisted = writeCacheFn.mock.calls[0]?.[1];
    expect(persisted?.session_id).toBe('ls_1');
    expect(persisted?.day_bucket).toBe('2026-07-06');
    expect(persisted?.watermarks.attempt_at).toBe('2026-07-06T08:00:00.000Z');
  });

  it('warm cache, no invalidation: reuses the cached header WITHOUT reassembling', async () => {
    const cached: LearnerStateHeaderCache = {
      header_md: '今日待复习 5 项',
      proposal_feedback: scopeCopilotProposalFeedback(rawFeedback),
      assembled_at: '2026-07-06T08:30:00.000Z',
      day_bucket: '2026-07-06',
      watermarks: WM({ attempt_at: '2026-07-06T08:00:00.000Z' }),
    };
    const readCacheFn = vi.fn(async () => cached);
    // Same watermarks as the cache → not stale.
    const readWatermarksFn = vi.fn(async () => WM({ attempt_at: '2026-07-06T08:00:00.000Z' }));
    const readProjectionFn = vi.fn(async () => PROJECTION({ reviewDueCount: 999 }));
    const loadProposalFeedbackFn = vi.fn(async () => rawFeedback);
    const writeCacheFn = vi.fn(async () => {});

    const header = await resolveLearnerStateHeader({} as never, 'ls_1', {
      readCacheFn,
      readWatermarksFn,
      readProjectionFn,
      loadProposalFeedbackFn,
      writeCacheFn,
      now,
    });

    // The expensive projection + digest reads did NOT run again (assemble-once).
    expect(readProjectionFn).not.toHaveBeenCalled();
    expect(loadProposalFeedbackFn).not.toHaveBeenCalled();
    expect(writeCacheFn).not.toHaveBeenCalled();
    expect(header.header_md).toBe('今日待复习 5 项');
    expect(header.proposal_feedback).toEqual(cached.proposal_feedback);
  });

  it('warm cache, proposal decision landed: reassembles + rewrites the cache', async () => {
    const cached: LearnerStateHeaderCache = {
      header_md: '(stale)',
      proposal_feedback: [],
      assembled_at: '2026-07-06T08:30:00.000Z',
      day_bucket: '2026-07-06',
      watermarks: WM({ proposal_decision_at: '2026-07-06T07:00:00.000Z' }),
    };
    const readCacheFn = vi.fn(async () => cached);
    // A newer proposal decision watermark → stale.
    const readWatermarksFn = vi.fn(async () =>
      WM({ proposal_decision_at: '2026-07-06T08:45:00.000Z' }),
    );
    const readProjectionFn = vi.fn(async () => PROJECTION({ reviewDueCount: 8 }));
    const loadProposalFeedbackFn = vi.fn(async () => rawFeedback);
    const writeCacheFn = vi.fn(async () => {});

    const header = await resolveLearnerStateHeader({} as never, 'ls_1', {
      readCacheFn,
      readWatermarksFn,
      readProjectionFn,
      loadProposalFeedbackFn,
      writeCacheFn,
      now,
    });

    expect(readProjectionFn).toHaveBeenCalledTimes(1);
    expect(writeCacheFn).toHaveBeenCalledTimes(1);
    expect(header.header_md).toContain('8');
    expect(header.proposal_feedback).toEqual(scopeCopilotProposalFeedback(rawFeedback));
  });

  // PR #717 bot review fix #1 (MAJOR) — readCache and readWatermarks were
  // coupled in ONE Promise.all, so a watermark-read failure (e.g. a transient DB
  // timeout) discarded an ALREADY-RESOLVED cached header and returned EMPTY_HEADER
  // — contradicting this module's own documented degrade contract ("any read
  // failure degrades to a stale cache (if any) or an empty header"). The two
  // reads must degrade INDEPENDENTLY: a watermark-read failure can't judge
  // staleness at all, so it must return the (valid) cache as-is, never EMPTY.
  it('a throwing readWatermarksFn with a valid cache degrades to the CACHED header, not EMPTY', async () => {
    const cached: LearnerStateHeaderCache = {
      header_md: '今日待复习 5 项',
      proposal_feedback: scopeCopilotProposalFeedback(rawFeedback),
      assembled_at: '2026-07-06T08:30:00.000Z',
      day_bucket: '2026-07-06',
      watermarks: WM({ attempt_at: '2026-07-06T08:00:00.000Z' }),
    };
    const readCacheFn = vi.fn(async () => cached);
    const readWatermarksFn = vi.fn(async () => {
      throw new Error('watermark read blew up (transient DB timeout)');
    });
    const readProjectionFn = vi.fn(async () => PROJECTION({ reviewDueCount: 999 }));
    const loadProposalFeedbackFn = vi.fn(async () => rawFeedback);
    const writeCacheFn = vi.fn(async () => {});

    const header = await resolveLearnerStateHeader({} as never, 'ls_1', {
      readCacheFn,
      readWatermarksFn,
      readProjectionFn,
      loadProposalFeedbackFn,
      writeCacheFn,
      now,
    });

    // Stale cache beats an empty header — we cannot judge staleness without
    // watermarks, so the safest move is to serve what we already had.
    expect(header.header_md).toBe(cached.header_md);
    expect(header.proposal_feedback).toEqual(cached.proposal_feedback);
    // No reassembly attempted (nothing to compare staleness against).
    expect(readProjectionFn).not.toHaveBeenCalled();
    expect(writeCacheFn).not.toHaveBeenCalled();
  });

  // PR #717 bot review fix #1 (MAJOR), counterpart branch — a cache-read
  // failure degrades to `cached=null` and the flow CONTINUES (attempts
  // reassembly using the watermarks it DID get), rather than bailing out
  // entirely. This is the "cold start" shape: no cache to reuse, so assemble.
  it('a throwing readCacheFn (with a healthy readWatermarksFn) degrades to cached=null and still reassembles', async () => {
    const readCacheFn = vi.fn(async () => {
      throw new Error('cache read blew up (transient DB timeout)');
    });
    const readWatermarksFn = vi.fn(async () => WM({ attempt_at: '2026-07-06T08:00:00.000Z' }));
    const readProjectionFn = vi.fn(async () => PROJECTION({ reviewDueCount: 3 }));
    const loadProposalFeedbackFn = vi.fn(async () => rawFeedback);
    const writeCacheFn = vi.fn(async () => {});

    const header = await resolveLearnerStateHeader({} as never, 'ls_1', {
      readCacheFn,
      readWatermarksFn,
      readProjectionFn,
      loadProposalFeedbackFn,
      writeCacheFn,
      now,
    });

    // No cache to compare against → treated as stale → full reassembly runs.
    expect(readProjectionFn).toHaveBeenCalledTimes(1);
    expect(writeCacheFn).toHaveBeenCalledTimes(1);
    expect(header.header_md).toContain('3');
    expect(header.proposal_feedback).toEqual(scopeCopilotProposalFeedback(rawFeedback));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanInput } from '@/capabilities/practice/public';
import { db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { GET as conjectureGet } from '../api/conjecture-scores';
import { GET as coverageGet } from '../api/coverage-lattice';
import {
  ConjectureScoresResponseSchema,
  CoverageLatticeResponseSchema,
} from '../api/diagnostic-contracts';
import {
  type ConjectureScoresRead,
  type CoverageLatticeRead,
  loadConjectureScores,
  loadCoverageLattice,
} from '../public';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  results: [] as unknown[][],
  assemble: vi.fn<typeof import('@/capabilities/practice/public').assembleScanInput>(),
  statuses: vi.fn<typeof import('@/capabilities/agency/public').getEffectiveProbeResultStatuses>(),
}));
vi.mock('@/db/client', () => ({ db: { select: mocks.select } }));
vi.mock('@/capabilities/practice/public', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/practice/public')>()),
  assembleScanInput: mocks.assemble,
}));
vi.mock('@/capabilities/agency/public', () => ({
  getEffectiveProbeResultStatuses: mocks.statuses,
}));

const now = new Date('2026-10-08T23:59:59.123Z');
const scan: ScanInput = {
  frontier: [
    { knowledgeId: 'empty', subjectId: 'yuwen', thetaHat: 0, thetaPrecision: 1, evidenceCount: 0 },
    { knowledgeId: 'thin', subjectId: 'math', thetaHat: 0.4, thetaPrecision: 2, evidenceCount: 9 },
    {
      knowledgeId: 'unknown',
      subjectId: 'unknown_subject',
      thetaHat: 0,
      thetaPrecision: 1,
      evidenceCount: 0,
    },
  ],
  questions: [
    {
      id: 'q',
      kind: 'choice',
      source: 'quiz_gen',
      metadata: { ambiguity: ['条件'.repeat(200), null] },
      difficulty: 3,
      calibrationB: null,
      knowledgeIds: ['thin'],
    },
  ],
  routePreferenceBySubject: { yuwen: ['author_question', 'ingest_existing'], math: ['quiz_gen'] },
  generationMethodBySubject: { yuwen: 'material_grounded', math: 'closed_book' },
  evidenceDemandControl: {
    neededBy: '2027-01-01T00:00:00Z',
    maxBudgetMicroUsd: 100,
    maxAttempts: 2,
  },
};
const score = {
  id: 'score',
  created_at: now,
  payload: {
    conjecture_event_id: 'conjecture',
    probe_result_event_id: 'probe',
    knowledge_id: 'thin',
    predicted_p: 0.3,
    baseline_p: 0.6,
    outcome: 0,
    resolution: 'confirmed',
    brier_model: 0.09,
    brier_baseline: 0.36,
    log_loss_model: 0.356,
    skill_score_point: 0.75,
    retrievability_at_judge: null,
    nested: { original: '证据、歧义、失败分支。'.repeat(200) },
  },
};
const typed = {
  id: 'typed',
  subject_kind: 'knowledge',
  subject_id: 'thin',
  typed_state: 'confused-with-X',
  confused_with_kc_id: 'rival',
  lifecycle: 'resolved',
  evidence_event_ids: ['probe', 'conjecture'],
  last_evidence_at: now,
  updated_at: now,
};
function queueScores() {
  mocks.results.push([score], [typed]);
}
function stableCoverage(value: CoverageLatticeRead) {
  expect(value.scan_ms).toBeGreaterThanOrEqual(0);
  return { ...value, scan_ms: 0 };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.assemble.mockReset().mockResolvedValue(structuredClone(scan));
  mocks.statuses.mockReset().mockResolvedValue(new Map([['probe', 'active']]));
  mocks.results = [];
  mocks.select.mockReset().mockImplementation(() => {
    const result = Promise.resolve(mocks.results.shift() ?? []);
    const query = Object.assign(result, {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
    });
    return query;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('public diagnostics reads and HTTP contracts', () => {
  it('preserves the full coverage DTO, registry names and real scanner projection over rich input', async () => {
    const read: CoverageLatticeRead = await loadCoverageLattice(db, now);
    expect(mocks.assemble).toHaveBeenCalledWith(db);
    expect(CoverageLatticeResponseSchema.parse(read)).toEqual(read);
    expect(read.generated_at).toBe(now.toISOString());
    expect(read.subjects.find((s) => s.subjectId === 'yuwen')?.displayName).toBeTruthy();
    expect(read.subjects.find((s) => s.subjectId === 'unknown_subject')?.displayName).toBeNull();
    const rows = read.subjects.flatMap((s) => s.kcs);
    expect(rows.find((r) => r.knowledgeId === 'empty')).toMatchObject({
      usableCount: 0,
      hasHighTier: null,
      hasNearThetaAnchor: null,
      formatDiverse: null,
    });
    expect(rows.find((r) => r.knowledgeId === 'thin')).toMatchObject({
      usableCount: 1,
      evidenceCount: 9,
      hasHighTier: false,
      hasNearThetaAnchor: false,
    });
    expect(JSON.stringify(read)).not.toContain('neededBy');
    expect(JSON.stringify(read)).not.toContain('2027-01-01');
    const response = await coverageGet();
    expect(response.status).toBe(200);
    expect(stableCoverage(CoverageLatticeResponseSchema.parse(await response.json()))).toEqual(
      stableCoverage(read),
    );
    expect(scan.questions[0].metadata).toEqual({ ambiguity: ['条件'.repeat(200), null] });
  });

  it('uses explicit now for activity/cooldown, omitted/undefined now for wall time, and elapsed scan_ms independently', async () => {
    mocks.assemble.mockImplementation(async () => {
      vi.advanceTimersByTime(37);
      return structuredClone(scan);
    });
    const first = await loadCoverageLattice(db, now);
    expect(first.scan_ms).toBe(37);
    const fingerprint = first.subjects.flatMap((s) => s.kcs).find((r) => r.knowledgeId === 'empty')
      ?.gaps[0].fingerprint;
    expect(fingerprint).toBeTypeOf('string');
    const dispatched = new Date(now.getTime() - first.cooldown_days * 86_400_000);
    const activities = [
      { payload: { fingerprint, status: 'dispatched' }, created_at: dispatched },
      {
        payload: { fingerprint, status: 'failed', detail: { text: '原始失败证据'.repeat(100) } },
        created_at: new Date(now.getTime() - 1),
      },
      { payload: { fingerprint: 42, status: 'dispatched' }, created_at: now },
      { payload: null, created_at: now },
    ];
    for (const offset of [-1, 0, 1]) {
      mocks.results.push(activities);
      const read = await loadCoverageLattice(db, new Date(now.getTime() + offset));
      const gap = read.subjects.flatMap((s) => s.kcs).find((r) => r.knowledgeId === 'empty')
        ?.gaps[0];
      expect(gap?.lastActivity).toEqual({
        lastActivityAt: new Date(now.getTime() - 1).toISOString(),
        lastStatus: 'failed',
        lastDispatchedAt: dispatched.toISOString(),
        inCooldown: offset < 0,
        cooldownUntil: now.toISOString(),
      });
      expect(read.generated_at).toBe(new Date(now.getTime() + offset).toISOString());
      expect(read.scan_ms).toBe(37);
    }
    vi.setSystemTime(now);
    expect((await loadCoverageLattice(db)).generated_at).toBe(now.toISOString());
    vi.setSystemTime(now);
    expect((await loadCoverageLattice(db, undefined)).generated_at).toBe(now.toISOString());
  });

  it('keeps empty active-goal coverage distinct from a nonzero scan', async () => {
    mocks.assemble.mockResolvedValue({ frontier: [], questions: [], routePreferenceBySubject: {} });
    const read = await loadCoverageLattice(db, now);
    expect(read.subjects).toEqual([]);
    expect(read.totals).toEqual({ activeKcs: 0, kcsWithGaps: 0, totalGaps: 0, gapsByKind: {} });
  });

  it('keeps every canonical score/typed-state field and complete HTTP bytes', async () => {
    queueScores();
    const read: ConjectureScoresRead = await loadConjectureScores(db);
    expect(ConjectureScoresResponseSchema.parse(read)).toEqual(read);
    expect(read).toEqual({
      score_basis: 'single_point',
      prediction_scores: [
        {
          event_id: 'score',
          ...Object.fromEntries(Object.entries(score.payload).filter(([key]) => key !== 'nested')),
          created_at: now.toISOString(),
        },
      ],
      typed_states: [
        {
          id: 'typed',
          knowledge_id: 'thin',
          typed_state: 'confused-with-X',
          confused_with_kc_id: 'rival',
          lifecycle: 'resolved',
          evidence_event_ids: ['probe', 'conjecture'],
          last_evidence_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
      ],
      diagnostics: {
        prediction_scores: { scanned_count: 1, dropped_count: 0, scan_truncated: false },
        typed_states: { scanned_count: 1, dropped_count: 0, scan_truncated: false },
      },
    });
    expect(mocks.statuses).toHaveBeenCalledWith(db, ['probe']);
    queueScores();
    const response = await conjectureGet();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(read));
  });

  it('preserves historical scores whose source status is missing', async () => {
    mocks.statuses.mockResolvedValue(new Map([['probe', 'missing']]));
    queueScores();
    const read = await loadConjectureScores(db);
    expect(read.prediction_scores.map((row) => row.event_id)).toEqual(['score']);
    expect(read.diagnostics.prediction_scores).toEqual({
      scanned_count: 1,
      dropped_count: 0,
      scan_truncated: false,
    });
  });

  it('distinguishes corrupt/corrected/dependency-inactive drops from an empty database', async () => {
    mocks.statuses.mockResolvedValue(
      new Map([
        ['corrected', 'corrected'],
        ['inactive', 'dependency_inactive'],
        ['probe', 'active'],
        ['missing', 'missing'],
      ]),
    );
    mocks.results.push(
      [
        score,
        {
          ...score,
          id: 'corrected',
          payload: { ...score.payload, probe_result_event_id: 'corrected' },
        },
        {
          ...score,
          id: 'inactive',
          payload: { ...score.payload, probe_result_event_id: 'inactive' },
        },
        { ...score, id: 'corrupt', payload: { ...score.payload, brier_model: 'invalid' } },
        { ...score, id: 'nan', payload: { ...score.payload, predicted_p: Number.NaN } },
      ],
      [{ ...typed, lifecycle: 'corrupt' }],
    );
    const read = await loadConjectureScores(db);
    expect(read.prediction_scores.map((r) => r.event_id)).toEqual(['score']);
    expect(read.diagnostics).toEqual({
      prediction_scores: { scanned_count: 5, dropped_count: 4, scan_truncated: false },
      typed_states: { scanned_count: 1, dropped_count: 1, scan_truncated: false },
    });
    const empty = await loadConjectureScores(db);
    expect(empty).toEqual({
      score_basis: 'single_point',
      prediction_scores: [],
      typed_states: [],
      diagnostics: {
        prediction_scores: { scanned_count: 0, dropped_count: 0, scan_truncated: false },
        typed_states: { scanned_count: 0, dropped_count: 0, scan_truncated: false },
      },
    });
  });

  it('preserves the 400 scan cap, sentinel and 200 result cap for both collections', async () => {
    const invalidScores = Array.from({ length: 201 }, (_, i) => ({
      ...score,
      id: `bad_${i}`,
      payload: { ...score.payload, predicted_p: 'bad' },
    }));
    const validScores = Array.from({ length: 200 }, (_, i) => ({ ...score, id: `valid_${i}` }));
    const invalidStates = Array.from({ length: 201 }, (_, i) => ({
      ...typed,
      id: `bad_${i}`,
      lifecycle: 'bad',
    }));
    const validStates = Array.from({ length: 200 }, (_, i) => ({ ...typed, id: `valid_${i}` }));
    mocks.results.push([...invalidScores, ...validScores], [...invalidStates, ...validStates]);
    const read = await loadConjectureScores(db);
    expect(read.prediction_scores).toHaveLength(199);
    expect(read.typed_states).toHaveLength(199);
    expect(read.diagnostics).toEqual({
      prediction_scores: { scanned_count: 400, dropped_count: 201, scan_truncated: true },
      typed_states: { scanned_count: 400, dropped_count: 201, scan_truncated: true },
    });
    mocks.results.push([...validScores, score], [...validStates, typed]);
    const capped = await loadConjectureScores(db);
    expect(capped.prediction_scores).toHaveLength(200);
    expect(capped.typed_states).toHaveLength(200);
    expect(capped.diagnostics.prediction_scores).toEqual({
      scanned_count: 200,
      dropped_count: 0,
      scan_truncated: true,
    });
    expect(capped.diagnostics.typed_states).toEqual(capped.diagnostics.prediction_scores);
  });

  it.each([
    ['coverage', coverageGet],
    ['conjecture', conjectureGet],
  ] as const)(
    '%s preserves public rejection and generic HTTP 500 without leaking details',
    async (_, get) => {
      const error = new Error('private database credential or SQL detail');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.select.mockImplementation(() => {
        throw error;
      });
      await expect(loadCoverageLattice(db, now)).rejects.toBe(error);
      await expect(loadConjectureScores(db)).rejects.toBe(error);
      const response = await get();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'internal_error',
        message: 'Internal Server Error',
      });
      expect(log).toHaveBeenCalled();
    },
  );

  it.each([coverageGet, conjectureGet])(
    'preserves structured HTTP errors and headers',
    async (get) => {
      mocks.select.mockImplementation(() => {
        throw new ApiError('unavailable', 'try later', 503, { 'Retry-After': '7' });
      });
      const response = await get();
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('7');
      expect(await response.json()).toEqual({ error: 'unavailable', message: 'try later' });
    },
  );
});

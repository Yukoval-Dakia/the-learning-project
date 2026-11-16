// YUK-1049 — Jev ModelUnitExecutorPort adapter unit tests (no DB).
//
// Only the wire transport is stubbed (fetchImpl). Start/retry are mocked on
// @/server/ai/log and the terminal writer on @/kernel/records/ai-attempt-facts,
// so lifecycle writers never touch Postgres — the REAL lifecycle state
// machine still drives admission/timeout/terminal accounting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => ({
  started: vi.fn(async (_db: unknown, _row: unknown) => {}),
  terminal: vi.fn(async (_db: unknown, _row: unknown) => true),
  retried: vi.fn(async (_db: unknown, _id: string) => true),
  tool: vi.fn(async () => 'tool-log-id'),
}));

vi.mock('@/server/ai/log', () => ({
  writeAiTaskRunStarted: logMocks.started,
  writeAiTaskRunRetried: logMocks.retried,
}));

vi.mock('@/kernel/records/ai-attempt-facts', async () => {
  const actual = await vi.importActual<typeof import('@/kernel/records/ai-attempt-facts')>(
    '@/kernel/records/ai-attempt-facts',
  );
  return {
    ...actual,
    writeAiTaskAttemptFinished: logMocks.terminal,
  };
});

vi.mock('@/kernel/tools/call-evidence', () => ({
  writeToolCallLog: logMocks.tool,
}));

import type { ModelExecutorRequest, ScoringUnitT, SlotResponseT } from '@/core/schema/assessment';
import { ScoringUnit } from '@/core/schema/assessment';
import { createJevModelExecutor } from './jev-model-executor';

const DEADLINE = Date.now() + 60_000;

function textEntry(text: string): SlotResponseT {
  return { slot_id: 's1', kind: 'text', text_md: text };
}

function ruleUnit(overrides: Partial<ScoringUnitT> = {}): ScoringUnitT {
  return {
    scoring_unit_id: 'u1',
    slot_refs: ['s1'],
    material_refs: [],
    evidence_slot_refs: [],
    requires_group_evidence: false,
    criterion: {
      kind: 'rule_reference',
      rule_id: 'r1',
      statement_md: 'Award full marks when the final answer is 4.',
      source: 'official',
    },
    points: 5,
    ...overrides,
  };
}

function request(overrides: Partial<ModelExecutorRequest> = {}): ModelExecutorRequest {
  return {
    submission_id: 'sub_1',
    evaluation_group_id: 'grp_1',
    revision_id: 'rev_1',
    attempt: 1,
    scoring_unit_id: 'u1',
    executor: {
      kind: 'model_executor',
      task_kind: 'JevScoringDecisionTask',
      admitted_slice_id: 'slice_en_short_answer_v1',
    },
    unit: ruleUnit(),
    question_parts: [
      { part_id: 'p1', prompt_md: '解方程：2x+3=11，写出移项步骤。', material_ids: [] },
    ],
    response_slots: [{ slot_id: 's1', part_id: 'p1', kind: 'text', math_preview: true }],
    slot_responses: [textEntry('x = 4')],
    group_evidence: [],
    materials: [],
    spent_cost_usd_micros: 0,
    ...overrides,
  };
}

function responseJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function executorOptions(overrides: Record<string, unknown> = {}) {
  return {
    db: {} as never,
    deadlineAt: DEADLINE,
    ruleThreshold: 0.8,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-or-key');
  logMocks.started.mockReset().mockResolvedValue(undefined);
  logMocks.terminal.mockReset().mockResolvedValue(true);
  logMocks.retried.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createJevModelExecutor — Jev lane', () => {
  // @invariant grading: a paid Jev pending (undecidable or a rule that declares the points unknown) keeps that call's run id and cost
  // @fails-if drop run_refs or cost_usd_micros on the pending returns inside interpretAnswer; two paid calls would settle as one
  it('keeps the run id and cost when a paid blank verdict stays pending', async () => {
    const pointsRule = {
      version: 1 as const,
      cases: [{ when: { correct: { eq: 1 } }, award: { points: 2 } }],
      otherwise: { points: 0 },
    };
    const unknownRule = {
      version: 1 as const,
      cases: [
        {
          when: { correct: { eq: 1 } },
          award: { unknown: 'partial_points_not_printed' as const },
        },
      ],
      otherwise: { points: 0 },
    };
    const blankRequest = (rule: typeof pointsRule | typeof unknownRule) =>
      request({
        unit: ScoringUnit.parse({
          scoring_unit_id: 'u1',
          slot_refs: ['s1'],
          criterion: {
            kind: 'blank_key',
            key: {
              kind: 'text',
              accepted: ['4'],
              normalization: { version: 'blank-norm-v1' },
              equivalence: { domain_md: 'algebraic value', meaning_md: 'the same number' },
            },
          },
          points: 2,
          rule,
        }),
        response_slots: [{ slot_id: 's1', part_id: 'p1', kind: 'blank', format: 'text' }],
        slot_responses: [{ slot_id: 's1', kind: 'blank', state: 'answered', text: 'four' }],
      });
    const cost = Math.round(4.2e-6 * 1_000_000);
    for (const example of [
      {
        rule: pointsRule,
        choice: 'undecidable',
        detail: 'equivalence_undecidable',
      },
      {
        rule: unknownRule,
        choice: 'equivalent',
        detail: 'partial_points_not_printed',
      },
    ]) {
      const fetchImpl = vi.fn(async () =>
        responseJson({
          model: 'typesafe/jev-1.13-20260917',
          provider: 'TypeSafe',
          answers: { u1: { type: 'choice', choice: example.choice } },
          usage: { input_tokens: 80, output_tokens: 6, cost: 4.2e-6 },
        }),
      ) as unknown as typeof fetch;
      const out = await createJevModelExecutor(executorOptions({ fetchImpl }))(
        blankRequest(example.rule),
      );
      expect(out).toMatchObject({
        kind: 'pending',
        pending: { detail: expect.stringContaining(example.detail) },
        cost_usd_micros: cost,
      });
      expect(out.run_refs).toHaveLength(1);
      expect(out.run_refs[0]).toBeTruthy();
    }
  });
});

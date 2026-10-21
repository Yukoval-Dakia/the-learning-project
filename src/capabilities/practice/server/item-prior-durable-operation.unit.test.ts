// Offline retained-consumer checks. Provider and persistence are stubbed; numeric
// parsing/aggregation and the retained handler's operation are real.
// Reservation fixtures verify consumer parsing/error handling only. Shared-store safety
// is exercised by the prepared real-DB cases, never manufactured by these fixtures.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runItemPriorBackfill } from '@/capabilities/practice/jobs/item_prior_backfill';
import {
  itemPriorPaidEffectInput,
  itemPriorPaidEffectRevision,
  validateItemPriorAppliedApplication,
} from '@/capabilities/practice/server/item-prior-paid-effect-adapter';
import { parseItemPriorOutput } from '@/core/item-prior-estimation';
import {
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
} from '@/core/migration/paid-effect-protocol';
import type { ItemPriorDraftT } from '@/core/schema/item_prior';
import type { Db } from '@/db/client';
import { item_calibration, knowledge, question } from '@/db/schema';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import { defaultSubjectProfile } from '@/subjects/profile';
import {
  ItemPriorApplicationError,
  type ItemPriorCandidateFrozen,
  type ItemPriorPreparedWork,
  type ItemPriorRepExecutionDeps,
  type ItemPriorStagedItem,
  commitItemPriorStagedCalibration,
  executeItemPriorRep,
  itemPriorRepIdentity,
  parseStagedItemPriorOutput,
  prepareItemPriorWork,
  runItemPriorItemRepStages,
  settleItemPriorStagedItem,
} from './item-prior-durable-operation';
import type { PracticeTaskRunFn } from './task-runtime';

// These tests exercise an in-memory read chain, not Drizzle SQL or a driver.
// Table/column tokens keep that control boundary entirely offline.
vi.mock('@/db/schema', () => ({
  question: {
    id: 'question.id',
    kind: 'question.kind',
    prompt_md: 'question.prompt_md',
    reference_md: 'question.reference_md',
    choices_md: 'question.choices_md',
    knowledge_ids: 'question.knowledge_ids',
  },
  knowledge: { id: 'knowledge.id', name: 'knowledge.name' },
  item_calibration: {
    question_id: 'item_calibration.question_id',
    track: 'item_calibration.track',
    b: 'item_calibration.b',
    b_anchor: 'item_calibration.b_anchor',
    confidence: 'item_calibration.confidence',
    source: 'item_calibration.source',
  },
}));
vi.mock('@/server/mastery/item-calibration', () => ({ applyItemPrior: vi.fn() }));
vi.mock('./knowledge-runtime', () => ({
  resolveSubjectProfileForKnowledgeIds: async () => defaultSubjectProfile,
}));

function candidate(id: string): ItemPriorCandidateFrozen {
  return {
    id,
    kind: 'short_answer',
    prompt_md: '比较两种解法的条件与结论。\n'.repeat(40),
    reference_md: '先分类讨论，再检查边界条件。',
    choices_md: null,
    knowledge_ids: ['kc_boundary', 'kc_unknown'],
  };
}

function database(candidates: ItemPriorCandidateFrozen[]): Db {
  // Test-only Drizzle read-chain double; no real connection or global client.
  // item_calibration reads return the test store as-is (the real query filters
  // question_id + track; tests keep at most one applied row readable at a time).
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === question)
            return { limit: async (limit: number) => candidates.slice(0, limit) };
          if (table === knowledge)
            return Promise.resolve([{ id: 'kc_boundary', name: '边界条件' }]);
          if (table === item_calibration)
            return Promise.resolve(
              structuredClone(
                calibrationRows.map(({ b, bAnchor, confidence, source }) => ({
                  b,
                  bAnchor,
                  confidence,
                  source,
                })),
              ),
            );
          throw new Error('Unexpected table');
        },
      }),
    }),
  } as unknown as Db;
}

function text(b: number, confidence: number) {
  return JSON.stringify({ b_logit: b, confidence, reasoning: '嵌套分类讨论与边界检查' });
}

/** In-memory hard-row store the mocked applyItemPrior writes into. Nullable
 * columns model foreign/partial rows for superseded assertions. */
let calibrationRows: Array<{
  question_id: string;
  b: number | null;
  bAnchor: number | null;
  confidence: number | null;
  source: string | null;
}>;

beforeEach(() => {
  vi.clearAllMocks();
  calibrationRows = [];
  vi.mocked(applyItemPrior).mockImplementation(async (_db, input) => {
    // Model PG float4 storage: real columns keep the float32 rounding.
    calibrationRows.push({
      question_id: input.questionId,
      b: Math.fround(input.draft.b_logit),
      bAnchor: Math.fround(input.draft.b_logit),
      confidence: Math.fround(input.draft.confidence),
      source: input.source ?? 'llm_prior',
    });
  });
});

function featureParams(): { method: 'feature'; reps: number } {
  return { method: 'feature', reps: 3 };
}

async function preparedWork(
  overrides: {
    candidate?: ItemPriorCandidateFrozen;
    method?: 'feature' | 'llasa';
    reps?: number;
  } = {},
): Promise<ItemPriorPreparedWork> {
  return prepareItemPriorWork(
    database([]),
    overrides.candidate ?? candidate('q_stage'),
    new Map([['kc_boundary', '边界条件']]),
    { method: overrides.method ?? 'feature', reps: overrides.reps ?? 3 },
  );
}

function queuedProvider(outputs: (string | Error)[]): {
  runTaskFn: PracticeTaskRunFn;
  calls: () => number;
} {
  let calls = 0;
  return {
    runTaskFn: async () => {
      calls++;
      const output = outputs.shift();
      if (output instanceof Error) throw output;
      return { text: output ?? '' };
    },
    calls: () => calls,
  };
}

const hostileProvider: PracticeTaskRunFn = () => {
  throw new Error('provider must not be called');
};

describe('item prior per-rep work identity', () => {
  // @invariant data: question revision and rendered-input digest move on independent axes
  // @fails-if editing knowledge names rekeys the question revision, or editing the question row leaves the input digest unchanged
  it('freezes question revision and input digest on independent axes', async () => {
    const base = candidate('q_stage');
    const names = new Map([['kc_boundary', '边界条件']]);
    const w1 = await prepareItemPriorWork(database([]), base, names, featureParams());
    const renamed = await prepareItemPriorWork(
      database([]),
      base,
      new Map([['kc_boundary', '重命名后的知识']]),
      featureParams(),
    );
    expect(renamed.questionRevision).toBe(w1.questionRevision); // candidate row unchanged
    expect(renamed.inputDigest).not.toBe(w1.inputDigest); // rendered input changed

    const llasa = await prepareItemPriorWork(database([]), base, names, {
      method: 'llasa',
      reps: 3,
    });
    expect(llasa.inputDigest).not.toBe(w1.inputDigest);
    expect(llasa.taskName).toBe('ItemPriorLlasaTask');
    expect(llasa.repCount).toBe(1); // reps never multiply LLaSA calls

    const edited = { ...base, prompt_md: `${base.prompt_md}\n题干修订。` };
    const w2 = await prepareItemPriorWork(database([]), edited, names, featureParams());
    expect(w2.questionRevision).not.toBe(w1.questionRevision);
    expect(w2.inputDigest).not.toBe(w1.inputDigest);

    const again = await prepareItemPriorWork(database([]), base, names, featureParams());
    expect(again).toEqual(w1); // deterministic preparation
  });

  // @invariant data: a rep is keyed by revision + input digest + rep index, never by delivery identity
  // @fails-if scheduler fields leak into the identity or rep indexing is unbounded
  it('keys a rep by revision, input digest and rep index only', async () => {
    const work = await preparedWork();
    const id0 = itemPriorRepIdentity(work, 0);
    expect(Object.keys(id0).sort()).toEqual([
      'inputDigest',
      'method',
      'questionId',
      'questionRevision',
      'repIndex',
    ]);
    expect(itemPriorRepIdentity(work, 1).repIndex).toBe(1);
    expect(() => itemPriorRepIdentity(work, work.repCount)).toThrow(RangeError);
  });
});

describe('item prior reservation consumer', () => {
  // @invariant data: a revision identifies the complete frozen workset required by B's sibling exemption
  // @fails-if changed input or rep count reuses an unknown workset revision, or a corrupted digest is sent
  it('binds the frozen revision to exact prepared input and rep count', async () => {
    const work = await preparedWork();
    const renamed = await prepareItemPriorWork(
      database([]),
      work.candidate,
      new Map([['kc_boundary', 'changed knowledge context']]),
      featureParams(),
    );
    expect(renamed.questionRevision).toBe(work.questionRevision);
    expect(itemPriorPaidEffectRevision(renamed)).not.toBe(itemPriorPaidEffectRevision(work));
    expect(itemPriorPaidEffectRevision({ ...work, repCount: 4 })).not.toBe(
      itemPriorPaidEffectRevision(work),
    );
    expect(itemPriorPaidEffectInput(work, 0)).toMatchObject({
      family: 'item_prior_backfill',
      entityId: work.candidate.id,
      entityRevision: itemPriorPaidEffectRevision(work),
      unit: 'feature/rep:0',
    });
    expect(() =>
      itemPriorPaidEffectInput({ ...work, inputDigest: renamed.inputDigest }, 0),
    ).toThrow('frozen input no longer matches');
  });

  // @invariant data: a held rep prevents later sibling sends on the same or a later night
  // @fails-if the per-item loop continues to reserve new siblings after an unknown or in-flight effect
  it('stops reserving later siblings after a held rep', async () => {
    const work = await preparedWork();
    const reserveRep = vi.fn<ItemPriorRepExecutionDeps['effects']['reserveRep']>(async () => ({
      kind: 'held',
      identity: computePaidEffectIdentity(itemPriorPaidEffectInput(work, 0)),
      state: 'unknown',
      blockedBy: null,
    }));
    const completeRep = vi.fn<ItemPriorRepExecutionDeps['effects']['completeRep']>();
    const staged = await runItemPriorItemRepStages(work, {
      effects: { reserveRep, completeRep },
      runTaskFn: hostileProvider,
    });
    expect(staged).toMatchObject({ status: 'held', heldReps: [0], pendingReps: [1, 2] });
    expect(reserveRep).toHaveBeenCalledTimes(1);
    expect(completeRep).not.toHaveBeenCalled();
  });

  // @invariant data: only a winner can send and completion carries the exact admitted fence
  // @fails-if the provider is called for held/completed, or the winner fence is dropped
  it('handles held, completed and winner reservations with the exact winner fence', async () => {
    const work = await preparedWork({ reps: 1 });
    const identity = computePaidEffectIdentity(itemPriorPaidEffectInput(work, 0));
    const outputText = text(0.4, 0.5);
    const winner = { kind: 'winner', identity, fence: 7 } as const;
    const completeRep = vi.fn<ItemPriorRepExecutionDeps['effects']['completeRep']>();
    const held: ItemPriorRepExecutionDeps['effects'] = {
      reserveRep: async () => ({ kind: 'held', identity, state: 'unknown', blockedBy: identity }),
      completeRep,
    };
    expect(
      await executeItemPriorRep(work, 0, { effects: held, runTaskFn: hostileProvider }),
    ).toEqual({ state: 'held' });
    const completed: ItemPriorRepExecutionDeps['effects'] = {
      reserveRep: async () => ({
        kind: 'completed',
        identity,
        state: 'receipt_ready',
        applied: false,
        application: null,
        result: { version: 1, kind: 'output', outputText },
      }),
      completeRep,
    };
    expect(
      await executeItemPriorRep(work, 0, { effects: completed, runTaskFn: hostileProvider }),
    ).toEqual({ state: 'draft', draft: parseItemPriorOutput(outputText) });
    const provider = queuedProvider([outputText]);
    await executeItemPriorRep(work, 0, {
      effects: { reserveRep: async () => winner, completeRep },
      runTaskFn: provider.runTaskFn,
    });
    expect(provider.calls()).toBe(1);
    expect(completeRep.mock.calls).toEqual([[winner, { version: 1, kind: 'output', outputText }]]);
  });

  // @invariant data: readonly recovery is incomplete, never a new paid send or completion
  // @fails-if an absent/pending terminal-job effect becomes a winner or discharges the work
  it('keeps terminal-job absent and pending recovery incomplete without running or completing', async () => {
    const work = await preparedWork({ reps: 1 });
    for (const effectState of [null, 'pending'] as const) {
      const runTaskFn = vi.fn(hostileProvider);
      const completeRep = vi.fn<ItemPriorRepExecutionDeps['effects']['completeRep']>();
      const staged = await runItemPriorItemRepStages(work, {
        effects: {
          reserveRep: async () => ({
            kind: 'recovery-only',
            identity: computePaidEffectIdentity(itemPriorPaidEffectInput(work, 0)),
            jobState: 'cancelled',
            effectState,
          }),
          completeRep,
        },
        runTaskFn,
      });
      expect(staged).toMatchObject({
        status: 'incomplete',
        pendingReps: [0],
        repOutcomes: [{ state: 'pending' }],
      });
      expect(runTaskFn).not.toHaveBeenCalled();
      expect(completeRep).not.toHaveBeenCalled();
    }
  });

  // @invariant data: durable-store and receipt failures cannot settle a rep
  // @fails-if store/receipt errors become drops, held in memory, or a successful draft
  it('propagates reservation and output/unknown persistence errors', async () => {
    const work = await preparedWork({ reps: 1 });
    const identity = computePaidEffectIdentity(itemPriorPaidEffectInput(work, 0));
    const completeRep = vi.fn<ItemPriorRepExecutionDeps['effects']['completeRep']>(async () => {
      throw new Error('receipt unavailable');
    });
    await expect(
      executeItemPriorRep(work, 0, {
        effects: {
          reserveRep: async () => {
            throw new Error('store unavailable');
          },
          completeRep,
        },
        runTaskFn: hostileProvider,
      }),
    ).rejects.toMatchObject({ code: 'ITEM_PRIOR_DURABLE_STORE' });
    expect(completeRep).not.toHaveBeenCalled();
    for (const output of [text(0.4, 0.5), new Error('send outcome unknown')]) {
      await expect(
        executeItemPriorRep(work, 0, {
          effects: {
            reserveRep: async () => ({ kind: 'winner', identity, fence: 7 }),
            completeRep,
          },
          runTaskFn: queuedProvider([output]).runTaskFn,
        }),
      ).rejects.toMatchObject({
        code: 'ITEM_PRIOR_RECEIPT_PERSISTENCE',
        identity: itemPriorRepIdentity(work, 0),
      });
    }
    expect(completeRep.mock.calls.map(([, receipt]) => receipt.kind)).toEqual([
      'output',
      'unknown',
    ]);
  });

  // @invariant grading: an unresolved rep blocks median application; invalid known results are drops
  // @fails-if held or missing reps produce an anchor, or malformed completed results become unknown
  it('requires every rep before applying the surviving median', async () => {
    const work = await preparedWork();
    const outcomes = [
      parseStagedItemPriorOutput('feature', text(0.1, 0.3)),
      parseStagedItemPriorOutput('feature', '{broken json'),
      parseStagedItemPriorOutput('feature', text(0.2, 0.5)),
    ];
    const ready = settleItemPriorStagedItem(work, outcomes);
    expect(ready.status).toBe('ready');
    expect(ready.draft?.b_logit).toBe((0.1 + 0.2) / 2);
    expect(ready.draft?.confidence).toBe(0.4);
    for (const state of ['held', 'pending'] as const) {
      const staged = settleItemPriorStagedItem(work, [outcomes[0], { state }, outcomes[2]]);
      expect(staged.status).toBe(state === 'held' ? 'held' : 'incomplete');
      expect(staged.draft).toBeUndefined();
      expect(await commitItemPriorStagedCalibration(database([]), staged)).toEqual({
        status: 'not-applicable',
      });
    }
    expect(vi.mocked(applyItemPrior)).not.toHaveBeenCalled();
  });
});

describe('retained item_prior_backfill consumer', () => {
  // @invariant grading: the retained default settles the median of three prior estimates
  // @fails-if default reps becomes one or aggregation uses the mean; persisted b/confidence differ
  it('passes the default three-rep median to the calibration writer', async () => {
    const outputs = [text(5.3, 0.9), text(0.1, 0.2), text(0.7, 0.4)];
    const runTaskFn: PracticeTaskRunFn = async () => ({ text: outputs.shift() ?? '' });
    const result = await runItemPriorBackfill(database([candidate('q_median')]), { runTaskFn });
    expect(result).toEqual({ considered: 1, calibrated: 1, skipped_failed: 0 });
    expect(vi.mocked(applyItemPrior).mock.calls.map(([, input]) => input)).toEqual([
      {
        questionId: 'q_median',
        draft: {
          b_logit: 0.7,
          confidence: 0.4,
          reasoning: expect.any(String),
        },
        source: 'llm_prior',
      },
    ]);
  });

  // @invariant grading: failed reps cannot invent anchors or prevent settlement of a later valid item
  // @fails-if failed reps are defaulted into drafts or all-failed handling escapes the item catch
  it('settles only surviving drafts and leaves the all-failed item uncalibrated', async () => {
    const outputs = [
      '{broken json',
      text(-0.4, 0.2),
      text(0.8, 0.6),
      'no output',
      new Error('connection lost after dispatch; paid outcome unknown'),
      text(7, 0.5),
      text(1.2, 0.3),
      text(1.4, 0.5),
      text(1.6, 0.7),
    ];
    const runTaskFn: PracticeTaskRunFn = async () => {
      const output = outputs.shift();
      if (output instanceof Error) throw output;
      return { text: output ?? '' };
    };
    const result = await runItemPriorBackfill(
      database([candidate('q_partial'), candidate('q_failed'), candidate('q_later')]),
      { runTaskFn },
    );
    expect(result).toEqual({ considered: 3, calibrated: 2, skipped_failed: 1 });
    const writes = vi.mocked(applyItemPrior).mock.calls.map(([, input]) => input);
    expect(writes.map(({ questionId }) => questionId)).toEqual(['q_partial', 'q_later']);
    expect(writes[0]?.draft.b_logit).toBeCloseTo(0.2, 10);
    expect(writes[0]?.draft.confidence).toBeCloseTo(0.4, 10);
    expect(writes[1]?.draft.b_logit).toBe(1.4);
    expect(writes[1]?.draft.confidence).toBe(0.5);
  });
});

describe('application verification seam', () => {
  /** A ready staged item with surviving drafts b ∈ {0.2, 0.8, 1.2} → median 0.8. */
  async function readyStagedItem(): Promise<{
    staged: Awaited<ReturnType<typeof runItemPriorItemRepStages>>;
    expectedDraft: ItemPriorDraftT;
  }> {
    const work = await preparedWork();
    const outputs = [text(0.2, 0.3), text(1.2, 0.5), text(0.8, 0.6)];
    const staged = settleItemPriorStagedItem(
      work,
      outputs.map((output) => parseStagedItemPriorOutput('feature', output)),
    );
    if (staged.status !== 'ready' || !staged.draft) throw new Error('fixture must settle ready');
    return { staged, expectedDraft: staged.draft };
  }

  // @invariant grading: a pre-existing differing hard row is never overwritten and never reported applied
  // @fails-if conflict-ignore is trusted as success or superseded rows are re-written
  it("reports superseded for another writer's differing hard row without writing", async () => {
    const { staged } = await readyStagedItem();
    calibrationRows.push({
      question_id: 'q_stage',
      b: -9.9,
      bAnchor: -9.9,
      confidence: 0.1,
      source: 'fixed_anchor',
    });
    const verification = await commitItemPriorStagedCalibration(database([]), staged);
    expect(verification).toEqual({
      status: 'superseded',
      existing: { b: -9.9, bAnchor: -9.9, confidence: 0.1, source: 'fixed_anchor' },
    });
    expect(vi.mocked(applyItemPrior)).not.toHaveBeenCalled();
    expect(calibrationRows).toHaveLength(1); // the foreign row is untouched
  });

  // @invariant grading: an already-matching hard row reports matched idempotently without a second write
  // @fails-if replay after application re-writes or reports superseded
  it('reports matched for a matching existing row without writing again', async () => {
    const { staged, expectedDraft } = await readyStagedItem();
    calibrationRows.push({
      question_id: 'q_stage',
      b: expectedDraft.b_logit,
      bAnchor: expectedDraft.b_logit,
      confidence: expectedDraft.confidence,
      source: 'llm_prior',
    });
    const verification = await commitItemPriorStagedCalibration(database([]), staged);
    expect(verification).toEqual({ status: 'matched' });
    expect(vi.mocked(applyItemPrior)).not.toHaveBeenCalled();
  });

  // @invariant data: an application write failure propagates as an application unknown
  // @fails-if the write error is swallowed into a boolean, a skip, or a completed result
  it('propagates an application write failure', async () => {
    const { staged } = await readyStagedItem();
    vi.mocked(applyItemPrior).mockImplementation(async () => {
      throw new Error('connection dropped mid-commit');
    });
    await expect(commitItemPriorStagedCalibration(database([]), staged)).rejects.toMatchObject({
      code: 'ITEM_PRIOR_APPLICATION',
    });
  });

  // @invariant data: a write that leaves no readable row is an application unknown
  // @fails-if a silent writer (no row) is reported applied
  it('propagates when a successful write leaves no readable hard row', async () => {
    const { staged } = await readyStagedItem();
    vi.mocked(applyItemPrior).mockImplementation(async () => {}); // succeeds, writes nothing
    const error = await commitItemPriorStagedCalibration(database([]), staged).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ItemPriorApplicationError);
    expect(error).toMatchObject({ code: 'ITEM_PRIOR_APPLICATION', questionId: 'q_stage' });
  });
});

describe('float4 application comparison', () => {
  // The database() double's item_calibration branch does not filter by
  // question_id, so each staged fixture keeps its own question id and each
  // case keeps at most one row in the store.
  function readyStaged(
    questionId: string,
    bLogit: number,
    confidence: number,
  ): ItemPriorStagedItem {
    const draft = { b_logit: bLogit, confidence, reasoning: 'float4 精度断言' };
    return {
      questionId,
      questionRevision: `rev_${questionId}`,
      inputDigest: `digest_${questionId}`,
      method: 'feature',
      repOutcomes: [{ state: 'draft', draft }],
      status: 'ready',
      draft,
      source: 'llm_prior',
      heldReps: [],
      pendingReps: [],
    };
  }

  // @invariant grading: float4 columns legally shorten even-count medians and high-precision values
  // @fails-if comparison uses strict double equality (fresh anchors misreport superseded) or a broad epsilon
  it('applies an even-count median and high-precision values across float4 storage', async () => {
    const evenMedian = (0.1 + 0.2) / 2; // double 0.15000000000000002
    const staged = readyStaged('q_f4_even', evenMedian, 1 / 3); // 0.3333333333333333
    expect(await commitItemPriorStagedCalibration(database([]), staged)).toEqual({
      status: 'matched',
    });
    expect(calibrationRows[0]).toMatchObject({ b: Math.fround(evenMedian) });

    calibrationRows.length = 0; // the double does not filter rows by question id
    const highPrecision = readyStaged('q_f4_high', 1.35792468, 0.1234567);
    expect(await commitItemPriorStagedCalibration(database([]), highPrecision)).toEqual({
      status: 'matched',
    });
  });

  // @invariant grading: re-committing the same staged draft is idempotent at float4 precision
  // @fails-if replay after application reports superseded or writes a second row
  it('re-verifies an already-persisted float4 row without writing again', async () => {
    const staged = readyStaged('q_f4_replay', (0.1 + 0.2) / 2, 1 / 3);
    expect(await commitItemPriorStagedCalibration(database([]), staged)).toEqual({
      status: 'matched',
    });
    expect(await commitItemPriorStagedCalibration(database([]), staged)).toEqual({
      status: 'matched',
    });
    expect(vi.mocked(applyItemPrior)).toHaveBeenCalledTimes(1);
  });

  // @invariant grading: values that differ beyond float4 representation are still superseded
  // @fails-if the comparison is widened into an epsilon that masks a different anchor
  it('keeps distinct anchors superseded without an epsilon', async () => {
    const stored = readyStaged('q_f4_distinct', 1.234567, 0.4);
    await commitItemPriorStagedCalibration(database([]), stored); // writes fround(1.234567)
    const adjacent = readyStaged('q_f4_distinct', 1.234568, 0.4); // distinct at float4 (step ≈1.2e-7 at 1.23)
    const verification = await commitItemPriorStagedCalibration(database([]), adjacent);
    expect(verification).toMatchObject({ status: 'superseded' });

    calibrationRows.length = 0;
    calibrationRows.push({
      question_id: 'q_f4_null',
      b: null,
      bAnchor: null,
      confidence: null,
      source: null,
    });
    const nullRow = await commitItemPriorStagedCalibration(
      database([]),
      readyStaged('q_f4_null', 0, 0.4),
    );
    expect(nullRow).toMatchObject({ status: 'superseded' }); // null never matches a finite draft
  });
});

describe('terminal item prior application compatibility (pure, no DB proof)', () => {
  async function terminalFixture() {
    const work = await preparedWork();
    const results = [0.1, 0.4, 0.2].map(
      (b) => ({ version: 1, kind: 'output', outputText: text(b, 0.5) }) as const,
    );
    const staged = settleItemPriorStagedItem(
      work,
      results.map((r) => parseStagedItemPriorOutput(work.method, r.outputText)),
    );
    const application = {
      version: 1,
      questionId: work.candidate.id,
      questionRevision: work.questionRevision,
      inputDigest: work.inputDigest,
      method: work.method,
      repCount: work.repCount,
      results: results.map((result, index) => ({
        identity: computePaidEffectIdentity(itemPriorPaidEffectInput(work, index)),
        resultDigest: computePaidEffectInputDigest(result),
      })),
      draft: staged.draft,
      disposition: { status: 'matched' },
    };
    return { work, results, staged, application };
  }

  // @invariant data: immutable terminal disposition is compatible with the full frozen workset and results
  // @fails-if a valid historical receipt requires recomputing a disposition from the current domain
  it('validates a complete historical matched or superseded application without domain reads', async () => {
    const { work, results, staged, application } = await terminalFixture();
    expect(
      validateItemPriorAppliedApplication(work, staged, results, [
        application,
        application,
        application,
      ]),
    ).toEqual({ status: 'matched' });
    const superseded = {
      ...application,
      disposition: {
        status: 'superseded',
        existing: { b: -1, bAnchor: -1, confidence: 1, source: 'fixed_anchor' },
      },
    };
    expect(
      validateItemPriorAppliedApplication(work, staged, results, [
        superseded,
        superseded,
        superseded,
      ]),
    ).toEqual(superseded.disposition);
    expect(vi.mocked(applyItemPrior)).not.toHaveBeenCalled();
  });

  // @invariant data: every coordinate and ordered result digest is bound to the immutable application
  // @fails-if a terminal marker alone accepts a different entity, revision, input, method, rep set or output
  it('rejects incompatible identity, result and application payloads', async () => {
    const { work, results, staged, application } = await terminalFixture();
    const invalid = [
      { ...application, questionId: 'another_question' },
      { ...application, questionRevision: 'another_revision' },
      { ...application, inputDigest: computePaidEffectInputDigest('different input') },
      { ...application, method: 'llasa' },
      { ...application, repCount: 2 },
      { ...application, results: [...application.results].reverse() },
      {
        ...application,
        results: application.results.map((r) => ({
          ...r,
          resultDigest: computePaidEffectInputDigest('different result'),
        })),
      },
      { ...application, draft: { ...staged.draft, reasoning: 'rewritten historical draft' } },
      { ...application, disposition: { status: 'no-anchor' } },
      { ...application, extra: 'unknown field' },
    ];
    for (const incompatible of invalid) {
      expect(() =>
        validateItemPriorAppliedApplication(work, staged, results, [
          incompatible,
          incompatible,
          incompatible,
        ]),
      ).toThrow();
    }
    expect(() =>
      validateItemPriorAppliedApplication(work, staged, results.slice(1), [
        application,
        application,
        application,
      ]),
    ).toThrow();
    expect(vi.mocked(applyItemPrior)).not.toHaveBeenCalled();
  });

  // @invariant data: terminal receipts must form one complete compatible application, never a partial union
  // @fails-if missing applications or individually valid different dispositions are silently considered complete
  it('rejects incomplete and differing terminal application sets', async () => {
    const { work, results, staged, application } = await terminalFixture();
    expect(() =>
      validateItemPriorAppliedApplication(work, staged, results, [application, application]),
    ).toThrow('incomplete');
    const superseded = {
      ...application,
      disposition: {
        status: 'superseded',
        existing: { b: -1, bAnchor: -1, confidence: 1, source: 'fixed_anchor' },
      },
    };
    expect(() =>
      validateItemPriorAppliedApplication(work, staged, results, [
        application,
        superseded,
        application,
      ]),
    ).toThrow('incompatible');
  });
});

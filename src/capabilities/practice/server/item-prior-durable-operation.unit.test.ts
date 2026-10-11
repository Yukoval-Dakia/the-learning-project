// Offline retained-consumer checks. Provider and persistence are stubbed; numeric
// parsing/aggregation and the retained handler's operation are real.
// Staged-rep checks drive the per-rep seams through a protocol-faithful port
// double whose records persist across invocations (modeling later deliveries).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runItemPriorBackfill } from '@/capabilities/practice/jobs/item_prior_backfill';
import { stableStringify } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { parseItemPriorLlasaOutput, parseItemPriorOutput } from '@/server/ai/item-prior';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import {
  type ItemPriorCandidateFrozen,
  type ItemPriorPreparedWork,
  type ItemPriorRepAdmission,
  type ItemPriorRepEffectPort,
  type ItemPriorRepIdentity,
  type ItemPriorRepReceipt,
  type ItemPriorRepRecord,
  commitItemPriorStagedCalibration,
  itemPriorRepIdentity,
  prepareItemPriorWork,
  runItemPriorItemRepStages,
} from './item-prior-durable-operation';
import type { PracticeTaskRunFn } from './task-runtime';

vi.mock('@/server/mastery/item-calibration', () => ({ applyItemPrior: vi.fn() }));
vi.mock('./knowledge-runtime', () => ({
  resolveSubjectProfileForKnowledgeIds: async () => undefined,
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
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === question)
            return { limit: async (limit: number) => candidates.slice(0, limit) };
          if (table === knowledge)
            return Promise.resolve([{ id: 'kc_boundary', name: '边界条件' }]);
          throw new Error('Unexpected table');
        },
      }),
    }),
  } as unknown as Db;
}

function text(b: number, confidence: number) {
  return JSON.stringify({ b_logit: b, confidence, reasoning: '嵌套分类讨论与边界检查' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** Test-only stand-in for lane B's durable store. Records persist for the
 * double's lifetime (across "deliveries"), completion is single-shot, and the
 * key is the work identity — never scheduler delivery identity. */
class PortDouble implements ItemPriorRepEffectPort {
  readonly records = new Map<string, ItemPriorRepRecord>();
  readonly admits: Array<{ identity: ItemPriorRepIdentity; decision: ItemPriorRepAdmission }> = [];
  readonly completes: Array<{ identity: ItemPriorRepIdentity; receipt: ItemPriorRepReceipt }> = [];
  admitOverride: ((identity: ItemPriorRepIdentity) => ItemPriorRepAdmission) | undefined;

  setRecord(identity: ItemPriorRepIdentity, record: ItemPriorRepRecord): void {
    this.records.set(stableStringify(identity), structuredClone(record));
  }

  getRecord(identity: ItemPriorRepIdentity): ItemPriorRepRecord | undefined {
    const record = this.records.get(stableStringify(identity));
    return record === undefined ? undefined : structuredClone(record);
  }

  lookupRep: ItemPriorRepEffectPort['lookupRep'] = async (identity) => this.getRecord(identity);

  admitRep: ItemPriorRepEffectPort['admitRep'] = async (identity) => {
    const decision: ItemPriorRepAdmission = this.records.has(stableStringify(identity))
      ? { decision: 'held' }
      : (this.admitOverride?.(identity) ?? { decision: 'admitted' });
    this.admits.push({ identity: { ...identity }, decision });
    return decision;
  };

  completeRep: ItemPriorRepEffectPort['completeRep'] = async (identity, receipt) => {
    const key = stableStringify(identity);
    if (this.records.has(key)) {
      throw new Error('PortDouble: immutable-receipt violation (second completion)');
    }
    this.records.set(
      key,
      receipt.kind === 'output'
        ? { state: 'output', outputText: receipt.outputText }
        : { state: 'unknown' },
    );
    this.completes.push({ identity: { ...identity }, receipt: structuredClone(receipt) });
  };
}

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

function llasaText(): string {
  return JSON.stringify({
    simulated_responses: [-2, -1, 0, 1, 2].map((theta, i) => ({
      theta_level: theta,
      student_answer_md: `第${i}档模拟学生的完整作答，包含分类讨论与边界检查。`,
      correct: theta >= 0,
      note: theta >= 0 ? '答对关键边界' : '漏掉分类情形',
    })),
    reasoning: '分层模拟作答反推难度',
  });
}

describe('item prior per-rep work identity', () => {
  // @invariant durability: question revision and rendered-input digest move on independent axes
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

  // @invariant durability: a rep is keyed by revision + input digest + rep index, never by delivery identity
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

describe('item prior staged rep execution', () => {
  // @invariant durability: a provider error records an unknown receipt and holds the item
  // @fails-if provider errors are dropped like parse failures or the item settles without every rep resolved
  it('records an unknown receipt on provider error and holds the item', async () => {
    const work = await preparedWork();
    const port = new PortDouble();
    const provider = queuedProvider([
      text(0.2, 0.3),
      new Error('connection lost after dispatch; paid outcome unknown'),
      text(0.8, 0.6),
    ]);
    const staged = await runItemPriorItemRepStages(work, { port, runTaskFn: provider.runTaskFn });
    expect(staged.status).toBe('held');
    expect(staged.heldReps).toEqual([1]);
    expect(staged.draft).toBeUndefined();
    expect(port.completes.map(({ receipt }) => receipt.kind)).toEqual([
      'output',
      'unknown',
      'output',
    ]);
    expect(await commitItemPriorStagedCalibration(undefined as unknown as Db, staged)).toBe(false);
    expect(vi.mocked(applyItemPrior)).not.toHaveBeenCalled();
  });

  // @invariant durability: a later delivery resumes staged reps without provider calls and keeps the unknown held
  // @fails-if resume re-admits resolved reps, re-sends the unknown rep, or treats it as retryable
  it('resumes staged reps on a later delivery without provider calls and keeps the unknown held', async () => {
    const work = await preparedWork();
    const port = new PortDouble();
    await runItemPriorItemRepStages(work, {
      port,
      runTaskFn: queuedProvider([
        text(0.2, 0.3),
        new Error('timeout; outcome unknown'),
        text(0.8, 0.6),
      ]).runTaskFn,
    });
    const admitsAfterFirst = port.admits.length;
    const completesAfterFirst = port.completes.length;

    const replay = await runItemPriorItemRepStages(work, { port, runTaskFn: hostileProvider });
    expect(replay.status).toBe('held');
    expect(replay.heldReps).toEqual([1]);
    expect(port.admits).toHaveLength(admitsAfterFirst); // resume via lookup only
    expect(port.completes).toHaveLength(completesAfterFirst); // receipts never mutated
    expect(port.getRecord(itemPriorRepIdentity(work, 1))).toEqual({ state: 'unknown' });
  });

  // @invariant durability: application happens from staged receipts alone once every rep resolved
  // @fails-if a resolved rep is re-sent or the median is recomputed from fewer than the surviving receipts
  it('settles and applies from staged receipts alone once every rep is resolved', async () => {
    const work = await preparedWork();
    const port = new PortDouble();
    const outputs = [text(0.2, 0.3), text(1.2, 0.5), text(0.8, 0.6)];
    for (const [repIndex, outputText] of outputs.entries()) {
      port.setRecord(itemPriorRepIdentity(work, repIndex), { state: 'output', outputText });
    }
    const staged = await runItemPriorItemRepStages(work, { port, runTaskFn: hostileProvider });
    expect(staged.status).toBe('ready');
    expect(staged.draft?.b_logit).toBe(0.8); // median of 0.2 / 0.8 / 1.2
    expect(staged.draft?.confidence).toBe(0.5); // median of 0.3 / 0.5 / 0.6
    expect(await commitItemPriorStagedCalibration(database([]), staged)).toBe(true);
    expect(vi.mocked(applyItemPrior)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyItemPrior).mock.calls[0]?.[1]).toEqual({
      questionId: 'q_stage',
      draft: staged.draft,
      source: 'llm_prior',
    });
  });

  // @invariant durability: changed input starts a new identity and never erases the old unknown
  // @fails-if the store is keyed per-run or a revision change overwrites prior obligations
  it('starts a new identity for changed input and keeps the old unknown record intact', async () => {
    const base = candidate('q_stage');
    const workV1 = await preparedWork({ candidate: base });
    const port = new PortDouble();
    const first = await runItemPriorItemRepStages(workV1, {
      port,
      runTaskFn: queuedProvider([
        text(0.2, 0.3),
        new Error('send failed after physical dispatch'),
        text(0.8, 0.6),
      ]).runTaskFn,
    });
    expect(first.status).toBe('held');
    const v1HeldIdentity = itemPriorRepIdentity(workV1, 1);

    const workV2 = await preparedWork({
      candidate: { ...base, prompt_md: `${base.prompt_md}\n题干修订 v2。` },
    });
    expect(workV2.questionRevision).not.toBe(workV1.questionRevision);
    expect(workV2.inputDigest).not.toBe(workV1.inputDigest);
    const second = await runItemPriorItemRepStages(workV2, {
      port,
      runTaskFn: queuedProvider([text(0.4, 0.2), text(0.6, 0.4), text(0.8, 0.3)]).runTaskFn,
    });
    expect(second.status).toBe('ready');

    // Old obligations untouched under their old identities.
    expect(port.getRecord(v1HeldIdentity)).toEqual({ state: 'unknown' });
    expect(port.getRecord(itemPriorRepIdentity(workV1, 0))).toEqual({
      state: 'output',
      outputText: text(0.2, 0.3),
    });
    expect(
      port.admits.filter(({ identity }) => identity.questionRevision === workV2.questionRevision),
    ).toHaveLength(3);
  });

  // @invariant durability: admission refusal means no paid effect and no send
  // @fails-if refusal is treated as a send, a held state, or an error
  it('maps admission refusal to an incomplete item without any send', async () => {
    const work = await preparedWork();
    const port = new PortDouble();
    port.admitOverride = () => ({ decision: 'refused', reason: 'backend control paused' });
    const staged = await runItemPriorItemRepStages(work, { port, runTaskFn: hostileProvider });
    expect(staged.status).toBe('incomplete');
    expect(staged.pendingReps).toEqual([0, 1, 2]);
    expect(port.completes).toHaveLength(0);
    expect(await commitItemPriorStagedCalibration(undefined as unknown as Db, staged)).toBe(false);
  });

  // @invariant durability: an existing unresolved claim holds the item without a second physical send
  // @fails-if a held admission re-sends or is downgraded to pending
  it('holds without sending when admission reports an existing unresolved claim', async () => {
    const work = await preparedWork();
    const port = new PortDouble();
    port.admitOverride = () => ({ decision: 'held' });
    const staged = await runItemPriorItemRepStages(work, { port, runTaskFn: hostileProvider });
    expect(staged.status).toBe('held');
    expect(staged.heldReps).toEqual([0, 1, 2]);
    expect(port.completes).toHaveLength(0);
  });

  // @invariant grading: completed-but-unparseable outputs are known drops, not retriable unknowns
  // @fails-if parse failures record unknown receipts or settle a draft anyway
  it('settles no-anchor when every completed output fails the parse barrier', async () => {
    const work = await preparedWork();
    const port = new PortDouble();
    const staged = await runItemPriorItemRepStages(work, {
      port,
      runTaskFn: queuedProvider(['{broken json', 'no object', '']).runTaskFn,
    });
    expect(staged.status).toBe('no-anchor');
    expect(staged.repOutcomes.every((o) => o.state === 'dropped')).toBe(true);
    expect(port.completes.every(({ receipt }) => receipt.kind === 'output')).toBe(true);
    expect(await commitItemPriorStagedCalibration(undefined as unknown as Db, staged)).toBe(false);
    expect(vi.mocked(applyItemPrior)).not.toHaveBeenCalled();
  });

  // @invariant grading: single-rep feature and LLaSA staged drafts stay byte-identical to the retained path
  // @fails-if staging wraps single-rep drafts in median provenance or adds LLaSA rep multiplication
  it('keeps single-rep feature and llasa staged drafts byte-identical to the retained path', async () => {
    const port = new PortDouble();
    const featureWork = await preparedWork({ reps: 1 });
    const out = text(1.4, 0.5);
    const stagedFeature = await runItemPriorItemRepStages(featureWork, {
      port,
      runTaskFn: queuedProvider([out]).runTaskFn,
    });
    expect(stagedFeature.status).toBe('ready');
    expect(stagedFeature.draft).toEqual(parseItemPriorOutput(out)); // no provenance suffix

    const llasaWork = await preparedWork({ method: 'llasa' });
    const stagedLlasa = await runItemPriorItemRepStages(llasaWork, {
      port,
      runTaskFn: queuedProvider([llasaText()]).runTaskFn,
    });
    expect(stagedLlasa.status).toBe('ready');
    expect(stagedLlasa.draft).toEqual(parseItemPriorLlasaOutput(llasaText()).prior);
    expect(stagedLlasa.source).toBe('llm_prior_llasa');
    expect(port.admits.filter(({ identity }) => identity.method === 'llasa')).toHaveLength(1); // one rep only
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

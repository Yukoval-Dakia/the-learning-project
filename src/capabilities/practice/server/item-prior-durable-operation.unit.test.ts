// Pure terminal-application compatibility seam for item priors: the only unit
// proof that an immutable applied application is bound to the complete frozen
// workset and every ordered result digest. Store races, float4 application and
// the backfill consumer are proven on real Postgres by
// tests/integration/item-prior-durable-member.db.test.ts and
// tests/integration/item_prior_backfill.db.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
} from '@/core/migration/paid-effect-protocol';
import type { Db } from '@/db/client';
import { item_calibration, knowledge, question } from '@/db/schema';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import { defaultSubjectProfile } from '@/subjects/profile';
import {
  type ItemPriorCandidateFrozen,
  type ItemPriorPreparedWork,
  parseStagedItemPriorOutput,
  prepareItemPriorWork,
  settleItemPriorStagedItem,
} from './item-prior-durable-operation';
import {
  itemPriorPaidEffectInput,
  validateItemPriorAppliedApplication,
} from './item-prior-paid-effect-adapter';

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
vi.mock('@/kernel/read-models/subject-profile', () => ({
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
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === question)
            return { limit: async (limit: number) => candidates.slice(0, limit) };
          if (table === knowledge)
            return Promise.resolve([{ id: 'kc_boundary', name: '边界条件' }]);
          if (table === item_calibration) return Promise.resolve([]);
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

async function preparedWork(): Promise<ItemPriorPreparedWork> {
  return prepareItemPriorWork(
    database([]),
    candidate('q_stage'),
    new Map([['kc_boundary', '边界条件']]),
    { method: 'feature', reps: 3 },
  );
}

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
});

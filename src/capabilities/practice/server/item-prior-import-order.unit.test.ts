import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { Db, Tx } from '@/db/client';

// Keep the production module graph, including public barrels and the task runner.
// A query through its global client must fail locally, before any driver access.
vi.mock('@/db/client', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('Unexpected global database access');
      },
    },
  ),
}));

const entries = ['operation', 'adapter', 'family', 'public'] as const;

async function modules(entry: (typeof entries)[number]) {
  vi.resetModules();
  switch (entry) {
    case 'operation':
      await import('./item-prior-durable-operation');
      break;
    case 'adapter':
      await import('./item-prior-paid-effect-adapter');
      break;
    case 'family':
      await import('@/server/durable/item-prior-family');
      break;
    case 'public':
      await import('@/capabilities/practice/public');
      break;
  }
  return {
    operation: await import('./item-prior-durable-operation'),
    adapter: await import('./item-prior-paid-effect-adapter'),
    protocol: await import('@/core/migration/paid-effect-protocol'),
    profile: (await import('@/subjects/profile')).defaultSubjectProfile,
  };
}

const request = {
  member: 'item_prior_backfill',
  dagRunId: 'run_import_order',
  nodeId: 'node_import_order',
  runDate: '2026-10-11',
  dispatch: {
    version: 1,
    backend: 'pg-boss',
    deliveryId: '11111111-1111-1111-1111-111111111111',
    tickId: 'run_import_order',
    generation: 0,
  },
} as const;

async function historicalFixture(entry: (typeof entries)[number], incompatible: boolean) {
  const { operation, adapter, protocol, profile } = await modules(entry);
  const args = {
    taskName: 'ItemPriorTask',
    input: {
      prompt_md: '分类讨论与边界检查。\n'.repeat(40),
      kind: 'short_answer',
      knowledge_context: [],
    },
    subjectProfile: profile,
  } as const;
  const work: import('./item-prior-durable-operation').ItemPriorPreparedWork = {
    ...args,
    candidate: {
      id: 'q_import_order',
      kind: 'short_answer',
      prompt_md: args.input.prompt_md,
      reference_md: '保留历史答案与边界条件',
      choices_md: null,
      knowledge_ids: [],
    },
    method: 'feature',
    questionRevision: 'frozen_revision',
    repCount: 3,
    inputDigest: protocol.computePaidEffectInputDigest(operation.itemPriorPreparedInput(args)),
  };
  const results = [0.1, 0.4, 0.2].map(
    (b) =>
      ({
        version: 1,
        kind: 'output',
        outputText: JSON.stringify({
          b_logit: b,
          confidence: 0.5,
          reasoning: '分类讨论与边界检查',
        }),
      }) as const,
  );
  const staged = operation.settleItemPriorStagedItem(
    work,
    results.map((r) => operation.parseStagedItemPriorOutput(work.method, r.outputText)),
  );
  const identities = results.map((_, index) =>
    protocol.computePaidEffectIdentity(adapter.itemPriorPaidEffectInput(work, index)),
  );
  const application = {
    version: 1,
    questionId: incompatible ? 'another_question' : work.candidate.id,
    questionRevision: work.questionRevision,
    inputDigest: work.inputDigest,
    method: work.method,
    repCount: work.repCount,
    results: results.map((result, index) => ({
      identity: identities[index],
      resultDigest: protocol.computePaidEffectInputDigest(result),
    })),
    draft: staged.draft,
    disposition: { status: 'matched' },
  };
  // Only the store's read chain is substituted. Its snapshot conversion and the
  // adapter's immutable receipt validation/error wrapper execute unchanged.
  let reads = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const index = reads++;
            const identity = identities[index];
            if (!identity) throw new Error('Unexpected extra receipt read');
            return [
              {
                family: identity.family,
                entity_id: identity.entityId,
                entity_revision: identity.entityRevision,
                unit: identity.unit,
                input_digest: identity.inputDigest,
                state: 'applied',
                fence: 1,
                delivery_backend: 'pg-boss',
                delivery_id: request.dispatch.deliveryId,
                delivery_tick: request.dagRunId,
                result_json: results[index],
                application_json: application,
              },
            ];
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async (fn: (tx: Tx) => Promise<unknown>) => fn(tx as unknown as Tx),
  } as unknown as Db;
  return {
    operation,
    effects: new adapter.ItemPriorPaidEffectAdapter(db, request),
    work,
    staged,
    reads: () => reads,
  };
}

describe('item prior real entry import order (offline)', () => {
  // @invariant data: the dispatched multiplier is bounded identically through every production entry
  // @fails-if a public cycle captures an uninitialized limit while constructing request schemas
  it.each(entries)('%s entry accepts valid reps and rejects reps above nine', async (entry) => {
    const { adapter } = await modules(entry);
    for (const reps of [1, 3, 9]) {
      expect(adapter.itemPriorDispatchedRequestSchema.parse({ ...request, reps })).toEqual({
        ...request,
        reps,
      });
    }
    expect(() => adapter.itemPriorDispatchedRequestSchema.parse({ ...request, reps: 10 })).toThrow(
      ZodError,
    );
  });

  // @invariant data: historical applications replay without domain writes independent of import order
  // @fails-if an eager schema captures an uninitialized operation binding and rejects an immutable receipt
  it.each(entries)('%s entry replays a compatible historical application', async (entry) => {
    const { effects, work, staged, reads } = await historicalFixture(entry, false);
    try {
      expect(await effects.commitStaged(work, staged)).toEqual({ status: 'matched' });
    } catch (error) {
      if (error instanceof Error && 'reason' in error) {
        throw new Error(error.message, { cause: error.reason });
      }
      throw error;
    }
    expect(reads()).toBe(3);
  });

  // @invariant data: an incompatible applied receipt keeps its application conflict cause
  // @fails-if schema initialization masks the strict compatibility error or permits rewritten history
  it.each(entries)('%s entry preserves the wrapped application conflict', async (entry) => {
    const { effects, work, staged, reads } = await historicalFixture(entry, true);
    await expect(effects.commitStaged(work, staged)).rejects.toMatchObject({
      code: 'ITEM_PRIOR_APPLICATION',
      reason: { name: 'PaidEffectApplicationConflictError' },
    });
    expect(reads()).toBe(3);
  });
});

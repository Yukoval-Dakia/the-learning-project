import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type KnowledgeMutationOutput,
  proposeKnowledgeMutationTool,
} from '@/capabilities/knowledge/server/tools/proposal-tools';
import { type Db, db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { resetDb } from '../../../../tests/helpers/db';
import { runKnowledgeMaintenanceNightly } from './knowledge_maintenance_nightly';

function proposeNewChild(db: Db, parentId: string, name: string, reasoning: string) {
  return proposeKnowledgeMutationTool.execute(
    { db, taskRunId: '', callerActor: { kind: 'agent', ref: 'dreaming' } },
    { change: { mutation: 'propose_new', parent_id: parentId, name }, reasoning },
  );
}

async function seedParentKnowledge(id = createId()) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: 'Foundation',
    domain: 'math',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('knowledge_maintenance_nightly handler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant concurrency: two maintenance runs racing one cooldown key leave exactly one pending proposal
  // @fails-if the proposal gate lock or pending-key check is skipped and both runs write a proposal
  it('does not create duplicate proposals when concurrent runs race the same cooldown key', async () => {
    const parentId = await seedParentKnowledge();
    let waiting = 0;
    let releaseBoth: (() => void) | null = null;
    const bothWaiting = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const waitForBoth = async () => {
      waiting += 1;
      if (waiting === 2) releaseBoth?.();
      await bothWaiting;
    };

    const run = () =>
      runKnowledgeMaintenanceNightly(db, {
        streamReviewTaskFn: async ({ db }) => {
          await waitForBoth();
          await proposeNewChild(
            db,
            parentId,
            'Raced child',
            'same concurrent maintenance proposal',
          );
          return new Response('done');
        },
      });

    await Promise.all([run(), run()]);

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(
      rows.filter((row) => row.payload.cooldown_key === `knowledge_node:${parentId}:Raced child`),
    ).toHaveLength(1);
  });

  // @invariant concurrency: a pending proposal's cooldown key blocks a second proposal from a later run
  // @fails-if the duplicate-pending check is bypassed and the inbox holds two pending rows
  it('does not create a second proposal when the same cooldown key is already pending', async () => {
    const parentId = await seedParentKnowledge();
    const first = await proposeNewChild(db, parentId, 'Duplicate child', 'first pending proposal');
    expect(first.status).toBe('proposed');

    let second: KnowledgeMutationOutput | null = null;
    const result = await runKnowledgeMaintenanceNightly(db, {
      streamReviewTaskFn: async ({ db }) => {
        second = await proposeNewChild(
          db,
          parentId,
          'Duplicate child',
          'same proposal should be skipped',
        );
        return new Response('done');
      },
    });

    expect(second).toMatchObject({
      status: 'skipped:duplicate_pending',
      proposal_id: first.proposal_id,
      cooldown_key: `knowledge_node:${parentId}:Duplicate child`,
    });
    expect(result.proposals_created).toBe(0);
    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows).toHaveLength(1);
  });
});

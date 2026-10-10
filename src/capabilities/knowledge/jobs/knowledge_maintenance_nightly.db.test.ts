import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { type WriteProposalResult, runWriteProposal } from '@/capabilities/knowledge/server/review';
import { db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { resetDb } from '../../../../tests/helpers/db';
import { runKnowledgeMaintenanceNightly } from './knowledge_maintenance_nightly';

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
          await runWriteProposal(db, {
            payload: { mutation: 'propose_new', parent_id: parentId, name: 'Raced child' },
            reasoning: 'same concurrent maintenance proposal',
          });
          return new Response('done');
        },
      });

    await Promise.all([run(), run()]);

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(
      rows.filter((row) => row.payload.cooldown_key === `knowledge_node:${parentId}:Raced child`),
    ).toHaveLength(1);
  });

  it('does not create a second proposal when the same cooldown key is already pending', async () => {
    const parentId = await seedParentKnowledge();
    const first = await runWriteProposal(db, {
      payload: { mutation: 'propose_new', parent_id: parentId, name: 'Duplicate child' },
      reasoning: 'first pending proposal',
    });
    expect(first.kind).toBe('tree_mutation');
    if (first.kind !== 'tree_mutation') throw new Error(`unexpected kind ${first.kind}`);

    let second: WriteProposalResult | null = null;
    const result = await runKnowledgeMaintenanceNightly(db, {
      streamReviewTaskFn: async ({ db }) => {
        second = await runWriteProposal(db, {
          payload: { mutation: 'propose_new', parent_id: parentId, name: 'Duplicate child' },
          reasoning: 'same proposal should be skipped',
        });
        return new Response('done');
      },
    });

    expect(second).toMatchObject({
      kind: 'skipped_duplicate',
      proposal_id: first.proposal_id,
      cooldown_key: `knowledge_node:${parentId}:Duplicate child`,
    });
    expect(result.proposals_created).toBe(0);
    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows).toHaveLength(1);
  });
});

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { type WriteProposalResult, runWriteProposal } from '@/server/knowledge/review';
import { dismissAiProposal } from '@/server/proposals/actions';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { eq } from 'drizzle-orm';
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

  it('runs the maintenance review producer and creates an inbox proposal', async () => {
    const parentId = await seedParentKnowledge();

    const result = await runKnowledgeMaintenanceNightly(db, {
      streamReviewTaskFn: async ({ db }) => {
        await runWriteProposal(db, {
          payload: {
            mutation: 'propose_new',
            parent_id: parentId,
            name: 'Maintenance child',
          },
          reasoning: 'attempt_event_e1 supports this split-out node',
        });
        return new Response('done');
      },
    });

    expect(result).toMatchObject({
      processed: 1,
      proposals_created: 1,
      pending_after: 1,
    });

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'knowledge_node',
      source_action: 'propose',
      source_subject_kind: 'knowledge',
    });
    expect(rows[0].payload.proposed_change).toMatchObject({
      mutation: 'propose_new',
      parent_id: parentId,
      name: 'Maintenance child',
    });

    const knowledgeRows = await db.select().from(knowledge);
    expect(knowledgeRows.map((row) => row.id)).toEqual([parentId]);
  });

  it('does not create a second proposal when the same cooldown key is already pending', async () => {
    const parentId = await seedParentKnowledge();
    const first = await runWriteProposal(db, {
      payload: { mutation: 'propose_new', parent_id: parentId, name: 'Duplicate child' },
      reasoning: 'first pending proposal',
    });
    expect(first.kind).toBe('tree_mutation');

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

  it('honors dismiss cooldown before creating a repeated proposal', async () => {
    const parentId = await seedParentKnowledge();
    const first = await runWriteProposal(db, {
      payload: { mutation: 'propose_new', parent_id: parentId, name: 'Cooled child' },
      reasoning: 'first pending proposal',
    });
    if (first.kind !== 'tree_mutation' || !first.proposal_id) {
      throw new Error('expected first proposal to be written');
    }
    await dismissAiProposal(db, first.proposal_id, { user_note: 'too broad' });

    let second: WriteProposalResult | null = null;
    const result = await runKnowledgeMaintenanceNightly(db, {
      streamReviewTaskFn: async ({ db }) => {
        second = await runWriteProposal(db, {
          payload: { mutation: 'propose_new', parent_id: parentId, name: 'Cooled child' },
          reasoning: 'same proposal is still in cooldown',
        });
        return new Response('done');
      },
    });

    expect(second).toMatchObject({
      kind: 'skipped_cooldown',
      proposal_id: first.proposal_id,
      cooldown_key: `knowledge_node:${parentId}:Cooled child`,
    });
    expect(result.proposals_created).toBe(0);

    const rows = await listProposalInboxRows(db);
    const matchingRows = rows.filter(
      (row) => row.payload.cooldown_key === `knowledge_node:${parentId}:Cooled child`,
    );
    expect(matchingRows).toHaveLength(1);
    expect(matchingRows[0].status).toBe('dismissed');

    const parentRows = await db.select().from(knowledge).where(eq(knowledge.id, parentId));
    expect(parentRows).toHaveLength(1);
  });
});

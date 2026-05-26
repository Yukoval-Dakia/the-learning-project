import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { knowledge, proposal_signals } from '@/db/schema';
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

  it('rethrows stream body errors so pg-boss can mark the job failed', async () => {
    await expect(
      runKnowledgeMaintenanceNightly(db, {
        streamReviewTaskFn: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('maintenance stream failed'));
              },
            }),
          ),
      }),
    ).rejects.toThrow('maintenance stream failed');
  });

  // YUK-68 (PR #117 codex P1): streamTask encodes per-turn failures in the
  // body text (`\n\n[streamTask] <msg>\n`) rather than throwing at the
  // transport level. Previously drained-without-parsing → handler returned
  // success and pg-boss never retried. Now we parse the body and throw.
  it('throws when stream body contains a [streamTask] error marker', async () => {
    await expect(
      runKnowledgeMaintenanceNightly(db, {
        streamReviewTaskFn: async () =>
          new Response('some assistant text\n\n[streamTask] timeout exceeded after 120000ms\n'),
      }),
    ).rejects.toThrow(/streamTask failure: \[streamTask\] timeout/);
  });

  it('still succeeds when stream body has no error marker', async () => {
    const parentId = await seedParentKnowledge();
    const result = await runKnowledgeMaintenanceNightly(db, {
      streamReviewTaskFn: async ({ db: innerDb }) => {
        await runWriteProposal(innerDb, {
          payload: { mutation: 'propose_new', parent_id: parentId, name: 'OK child' },
          reasoning: 'no stream error',
        });
        return new Response('some normal assistant text without any markers\n');
      },
    });
    expect(result.processed).toBe(1);
    expect(result.proposals_created).toBe(1);
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

  it('honors active cooldown rows without scanning the proposal inbox', async () => {
    const parentId = await seedParentKnowledge();
    const cooldownKey = `knowledge_node:${parentId}:Cooled by signal`;
    await db.insert(proposal_signals).values({
      id: createId(),
      kind: 'knowledge_node',
      cooldown_key: cooldownKey,
      accept_count: 0,
      dismiss_count: 1,
      acceptance_rate: 0,
      dismiss_reason: 'recently dismissed',
      cooldown_until: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
    });

    const result = await runWriteProposal(db, {
      payload: { mutation: 'propose_new', parent_id: parentId, name: 'Cooled by signal' },
      reasoning: 'active cooldown should skip this proposal',
    });

    expect(result).toMatchObject({
      kind: 'skipped_cooldown',
      cooldown_key: cooldownKey,
    });
    const rows = await listProposalInboxRows(db);
    expect(rows).toHaveLength(0);
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

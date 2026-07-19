// YUK-525 security regression — completion tool execution is proposal-only.

import { event, knowledge, learning_item } from '@/db/schema';
import { acceptAiProposal } from '@/server/proposals/actions';
import { getProposalInboxRow } from '@/server/proposals/inbox';
import { and, eq, like } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { proposeLearningItemCompletionTool } from './proposal-tools';
import type { ToolContext } from './types';

const mockRunner = vi.hoisted(() => ({ runTask: vi.fn() }));
vi.mock('@/server/ai/runner', () => ({ runTask: mockRunner.runTask }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((opts: unknown) => ({ type: 'sdk', instance: opts })),
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name,
    handler,
  })),
}));

const BASE = new Date('2026-05-28T00:00:00.000Z');

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_completion_propose',
    callerActor: { kind: 'agent', ref: 'agent:maintenance' },
  };
}

async function seedItem(): Promise<void> {
  await testDb().insert(knowledge).values({
    id: 'k_zhi',
    name: '之',
    domain: 'yuwen',
    created_at: BASE,
    updated_at: BASE,
  });
  await testDb()
    .insert(learning_item)
    .values({
      id: 'li_completion',
      source: 'manual',
      title: '之',
      content: 'content',
      knowledge_ids: ['k_zhi'],
      status: 'in_progress',
      created_at: BASE,
      updated_at: BASE,
    });
}

describe('completion proposal human-approval boundary (YUK-525)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedItem();
  });

  it('writes only a pending proposal and leaves the learning item untouched', async () => {
    const db = testDb();
    const out = await proposeLearningItemCompletionTool.execute(ctx(), {
      learning_item_id: 'li_completion',
      triggering_signals: ['check_all_passed'],
      reasoning: 'all checks passed',
    });

    expect(out).toMatchObject({ status: 'proposed', auto_applied: false });
    const proposalId = out.proposal_id as string;
    expect((await getProposalInboxRow(db, proposalId))?.status).toBe('pending');

    const item = (
      await db
        .select({ status: learning_item.status })
        .from(learning_item)
        .where(eq(learning_item.id, 'li_completion'))
    )[0];
    expect(item.status).toBe('in_progress');

    const decisions = await db
      .select({ action: event.action })
      .from(event)
      .where(
        and(
          eq(event.subject_id, 'li_completion'),
          like(event.action, 'experimental:completion_autoapply%'),
        ),
      );
    expect(decisions).toHaveLength(0);
    const rates = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rates).toHaveLength(0);
  });

  it('materializes completion only after the canonical explicit accept', async () => {
    const db = testDb();
    const out = await proposeLearningItemCompletionTool.execute(ctx(), {
      learning_item_id: 'li_completion',
      triggering_signals: ['check_all_passed'],
      reasoning: 'all checks passed',
    });

    await acceptAiProposal(db, out.proposal_id as string);

    const item = (
      await db
        .select({ status: learning_item.status })
        .from(learning_item)
        .where(eq(learning_item.id, 'li_completion'))
    )[0];
    expect(item.status).toBe('done');
  });
});

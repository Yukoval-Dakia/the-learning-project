import { vi } from 'vitest';
import {
  type KnowledgeMutationPayload,
  acceptProposal,
  writeKnowledgeProposeEvent,
} from '@/capabilities/knowledge/server/proposals';
import type { Db } from '@/db/client';
import { backfillKnowledgeGenesis } from '../../scripts/backfill-genesis-events';

/** Fixture preparation followed by the real proposal/accept owner, never raw applier DML. */
export async function acceptKnowledgeMutationFixture(
  db: Db,
  payload: KnowledgeMutationPayload,
  at?: Date,
) {
  if (at) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at.getTime() - 1));
  }
  try {
    await backfillKnowledgeGenesis(db);
    if (at) vi.setSystemTime(at);
    const id = await writeKnowledgeProposeEvent(db, {
      payload,
      reasoning: '显式接受结构变更；保留版本、历史、派生状态与失败回滚验证。',
    });
    return await acceptProposal(db, id);
  } finally {
    if (at) vi.useRealTimers();
  }
}

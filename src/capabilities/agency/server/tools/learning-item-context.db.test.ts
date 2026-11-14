import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import {
  writeCopilotInputEvent,
  writeCopilotReply,
} from '@/capabilities/copilot/server/conversation-writes';
import { claimCopilotExecutionFence } from '@/capabilities/copilot/server/copilot-run-settlement';
import { changeIngestionPurpose } from '@/capabilities/ingestion/server/purpose-change';
import { learning_session, source_document } from '@/db/schema';
import { sourceAllowsDerivation } from '@/kernel/read-models/usage-policy';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import {
  seedCompletionLearningItem,
  seedCompletionProposal,
} from '../../../../../tests/helpers/native-completion';
import { getLearningItemContextTool } from './learning-item-context';

beforeEach(resetDb);
// @invariant security: a completion summary consumed by a model retains its frozen source authority in later reply history
// @fails-if revoking then relaxing a source lets the old tool summary or derived reply re-enter model context
it('keeps completion tool evidence and its derived reply unavailable after source epoch changes', async () => {
  const db = testDb();
  const now = new Date();
  await db.insert(source_document).values({
    id: 'source',
    title: 'synthetic',
    provenance: { usage_policy: { derivation_policy: 'allow' }, usage_epoch: 'initial' },
    created_at: now,
    updated_at: now,
  });
  await db.insert(learning_session).values([
    {
      id: 'ingestion',
      type: 'ingestion',
      status: 'completed',
      source_document_id: 'source',
      created_at: now,
      updated_at: now,
    },
    {
      id: 'conversation',
      type: 'conversation',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  ]);
  await seedCompletionLearningItem(db, 'item', 'source');
  await seedCompletionProposal(db, 'proposal', 'item');
  await acceptAiProposal(db, 'proposal');
  const ask = await writeCopilotInputEvent(db, {
    sessionId: 'conversation',
    userMessage: '检查证据',
    derivationPolicy: 'allow',
    now,
  });
  await claimCopilotExecutionFence(db, ask, { historyReadSet: { version: 1, event_ids: [] } });
  const ctx = {
    db,
    taskRunId: 'synthetic',
    causedByEventId: ask,
    callerActor: { kind: 'agent' as const, ref: 'copilot' },
  };
  const read = () =>
    getLearningItemContextTool.execute(ctx, {
      learningItemId: 'item',
      include: ['completion_evidence'],
    });
  const allowed = await read();
  expect(allowed.evidence?.[0].summary).toContain('掌握度');
  const reply = await writeCopilotReply(db, {
    sessionId: 'conversation',
    userAskEventId: ask,
    replyText: allowed.evidence?.[0].summary ?? '',
    actorRef: 'copilot',
    taskRunId: 'synthetic',
    now,
  });
  const source = { kind: 'event' as const, id: reply.replyEventId };
  expect(await sourceAllowsDerivation(db, source)).toBe(true);
  for (const [version, target] of ['answer_only', 'allow'].entries()) {
    await changeIngestionPurpose(db, 'ingestion', {
      request_id: randomUUID(),
      source_document_id: 'source',
      expected_version: version,
      target: target === 'allow' ? 'allow' : 'answer_only',
    });
    expect((await read()).evidence?.[0].summary).toBe('完成依据暂不可用');
    expect(await sourceAllowsDerivation(db, source)).toBe(false);
  }
});

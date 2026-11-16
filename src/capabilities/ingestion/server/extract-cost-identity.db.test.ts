// Extract-lane cost identities must survive on the same session row the cost
// evidence read loads — a lost binding silently turns a real cost into「未知」
// (data-preservation class, AGENTS.md invariant #1).

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';
import { readAgentBudget } from './agent/budget-state';
import { extractCostIdentitiesOf, recordExtractCostIdentities } from './extract-cost-identity';

const sessionIds: string[] = [];

async function newSession(): Promise<string> {
  const id = `sess_${newId()}`;
  sessionIds.push(id);
  await db.insert(learning_session).values({ id, type: 'ingestion', status: 'extracted' });
  return id;
}

afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(learning_session).where(eq(learning_session.id, sessionId));
  }
});

describe('extract cost identities', () => {
  beforeEach(resetDb);

  // @invariant data: extract-lane paid identities must persist on the session so cost evidence stays attributable
  // @fails-if the writer drops task_run_ids/ocr_operation_ids, overwrites the envelope, or stops deduping
  it('persists and unions paid identities on the session envelope', async () => {
    const sessionId = await newSession();
    const opA = crypto.randomUUID();
    const opB = crypto.randomUUID();

    await recordExtractCostIdentities(db, sessionId, {
      taskRunIds: ['run-structure-1'],
      ocrOperationIds: [opA],
    });
    await recordExtractCostIdentities(db, sessionId, {
      taskRunIds: ['run-assembly-2', 'run-structure-1'],
      ocrOperationIds: [opB, opA, 'not-a-uuid'],
    });

    const budget = await readAgentBudget(db, sessionId);
    expect(extractCostIdentitiesOf(budget)).toEqual({
      task_run_ids: ['run-structure-1', 'run-assembly-2'],
      ocr_operation_ids: [opA, opB],
    });
  });
});

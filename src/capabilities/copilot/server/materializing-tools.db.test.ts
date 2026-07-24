import { createId } from '@paralleldrive/cuid2';
import { afterEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { inArray } from 'drizzle-orm';
import {
  MATERIALIZING_TOOL_NAMES,
  selectAsksWithMaterializingToolCall,
} from './materializing-tools';

// This helper is the SINGLE source both chat.ts (live) and turns.ts (replay) key the revert-anchor
// suppression on, so live and replay can't diverge. Prove its query semantics directly.
const written: string[] = [];
afterEach(async () => {
  if (written.length > 0) {
    await db.delete(event).where(inArray(event.id, written));
    written.length = 0;
  }
});

async function writeToolUse(causedBy: string | null, toolName: string): Promise<string> {
  const id = `tool_use_${createId()}`;
  written.push(id);
  await writeEvent(db, {
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot',
    action: 'tool_use',
    subject_kind: 'query',
    subject_id: id,
    outcome: 'success',
    payload: { tool_name: toolName, args: {} },
    caused_by_event_id: causedBy,
    created_at: new Date(),
  });
  return id;
}

describe('selectAsksWithMaterializingToolCall', () => {
  it('returns exactly the asks whose turn emitted a materializing tool_use', async () => {
    const askMat = `copilot_user_ask_${createId()}`;
    const askProp = `copilot_user_ask_${createId()}`;
    const askNone = `copilot_user_ask_${createId()}`;
    await writeToolUse(askMat, 'author_question'); // materializing → askMat included
    await writeToolUse(askProp, 'propose_knowledge_edge'); // pure-event → askProp excluded
    // askNone had no tool_use at all → excluded.

    const result = await selectAsksWithMaterializingToolCall(db, [askMat, askProp, askNone]);
    expect(result.has(askMat)).toBe(true);
    expect(result.has(askProp)).toBe(false);
    expect(result.has(askNone)).toBe(false);
  });

  it('matches every declared materializing tool and scopes strictly by caused_by ask id', async () => {
    const ask = `copilot_user_ask_${createId()}`;
    const otherAsk = `copilot_user_ask_${createId()}`;
    for (const tool of MATERIALIZING_TOOL_NAMES) await writeToolUse(ask, tool);
    // A materializing tool_use under a DIFFERENT ask must not leak into `ask`'s result.
    await writeToolUse(otherAsk, 'author_artifact');

    expect((await selectAsksWithMaterializingToolCall(db, [ask])).has(ask)).toBe(true);
    // Only the queried ids are returned; otherAsk is not in the query set.
    const scoped = await selectAsksWithMaterializingToolCall(db, [ask]);
    expect(scoped.has(otherAsk)).toBe(false);
  });

  it('returns an empty set for no ask ids (no query issued)', async () => {
    expect((await selectAsksWithMaterializingToolCall(db, [])).size).toBe(0);
  });
});

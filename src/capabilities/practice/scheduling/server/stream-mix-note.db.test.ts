// The coach prompt and the companion segment read through readAgentNotes, which drops
// notes whose refs cannot be derived — writing a note is not enough on its own.

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { question } from '@/db/schema';
import { readAgentNotes } from '@/kernel/read-models/agent-note-hints';
import { streamLocalDate } from '@/kernel/stream-date';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { writeStreamMixNote } from './stream-mix-note';

// The learner day the stream store composes under.
const DAY = streamLocalDate();

async function seedQuestion(): Promise<string> {
  const id = createId();
  const now = new Date();
  await testDb().insert(question).values({
    id,
    kind: 'choice',
    prompt_md: '题干',
    reference_md: 'B',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    draft_status: null,
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('stream mix note read path', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant security: the backlog note reaches the coach through the derivation filter,
  // and the day's later compose withdraws the numbers it replaced.
  // @fails-if the note cites a non-derivable ref kind (no reader sees it), or a fit day
  // leaves the earlier backlog text readable.
  it('is readable through the agent-note read model and withdrawn when the day fits', async () => {
    const questionId = await seedQuestion();
    const now = new Date();
    const backlog = {
      kind: 'backlog' as const,
      reason: 'due_backlog',
      summary: '今天复习很多，是因为到期题积压。',
      refs: [{ kind: 'question' as const, id: questionId }],
    };

    await writeStreamMixNote(testDb(), DAY, backlog);
    // Repeating the same compose must not add a second note.
    await writeStreamMixNote(testDb(), DAY, backlog);
    const notes = await readAgentNotes(testDb(), { for_agent: 'coach', now });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.refs).toEqual([{ kind: 'question', id: questionId }]);

    // Same-day recompose that now fits: the earlier text stops reaching readers.
    await writeStreamMixNote(testDb(), DAY, { kind: 'fits' });
    expect(await readAgentNotes(testDb(), { for_agent: 'coach', now })).toEqual([]);
  });
});

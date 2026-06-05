// AF S4 / YUK-203 U6 (OQ6, R4/R7) — solve-skill DB tests.
//
// The solve-skill provides a NON-REVEALING hint via TeachingTurnTask called
// DIRECTLY (not via the tutor-bound planSolveHint). Acceptance:
//   - returns a non-revealing hint (reuses the solve.test.ts non-reveal shape),
//   - writes NO judge/attempt event (R4),
//   - opens/mutates NO tutor session from the Copilot path (R7),
//   - seeds the SAME input as the tutor route (question face + reference only).

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { event, learning_session, question } from '@/db/schema';
import { buildSolveHintInput } from '@/server/orchestrator/solve';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runSolveSkill } from './solve-skill';

const db = testDb();

async function seedQuestion(): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '化简 (a^2 - b^2)/(a - b)',
    reference_md: '完整解：先因式分解，再约分得 a+b。',
    rubric_json: null,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
  });
  return id;
}

describe('runSolveSkill (U6 solve skill)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a non-revealing hint via a direct TeachingTurnTask call', async () => {
    const id = await seedQuestion();
    const turnText = JSON.stringify({
      kind: 'explain',
      text_md: '想想分子能不能因式分解？',
      suggested_next: 'continue',
    });
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_hint',
      text: turnText,
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));

    const result = await runSolveSkill({ db, questionId: id }, { runAgentTaskFn });

    expect(result.text_md).toContain('因式分解');
    expect(result.text_md).not.toContain('a+b'); // does not reveal the final answer

    // Called TeachingTurnTask with allowedTools:[] (no memory, no tool budget — R6).
    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'TeachingTurnTask',
      expect.anything(),
      expect.objectContaining({ allowedTools: [] }),
    );

    // R4: NO judge/attempt event written by the solve-skill.
    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts).toHaveLength(0);
    const judges = await db.select().from(event).where(eq(event.action, 'judge'));
    expect(judges).toHaveLength(0);

    // R7: NO tutor session created/mutated from the Copilot path.
    const tutorSessions = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.type, 'tutor'));
    expect(tutorSessions).toHaveLength(0);
  });

  it('seeds the SAME input as the tutor route (question face + reference only)', async () => {
    const id = await seedQuestion();
    let capturedInput: unknown;
    const runAgentTaskFn = vi.fn(async (_kind, input) => {
      capturedInput = input;
      return {
        task_run_id: 'task_seed',
        text: JSON.stringify({ kind: 'explain', text_md: 'hint', suggested_next: 'continue' }),
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 2 },
      };
    });

    await runSolveSkill({ db, questionId: id, hintIndex: 0 }, { runAgentTaskFn });

    // The skill input is the shared buildSolveHintInput seed — face + reference,
    // no prior attempts, no memory content.
    const expected = buildSolveHintInput(
      { prompt_md: '化简 (a^2 - b^2)/(a - b)', reference_md: '完整解：先因式分解，再约分得 a+b。' },
      0,
    );
    expect(capturedInput).toEqual(expected);
  });

  it('throws for an unknown question', async () => {
    const runAgentTaskFn = vi.fn();
    await expect(runSolveSkill({ db, questionId: 'nope' }, { runAgentTaskFn })).rejects.toThrow();
    expect(runAgentTaskFn).not.toHaveBeenCalled();
  });
});

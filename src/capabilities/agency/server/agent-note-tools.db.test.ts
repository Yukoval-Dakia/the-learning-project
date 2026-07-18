import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event } from '@/db/schema';
import type { ToolContext } from '@/server/ai/tools/types';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { readAgentNotesTool, writeAgentNoteTool } from './agent-note-tools';
import { writeAgentNote } from './notes';

function context(ref: string, kind: ToolContext['callerActor']['kind'] = 'agent'): ToolContext {
  return {
    db: testDb(),
    taskRunId: `run_${ref.replace(/[^a-z]/gi, '_')}`,
    callerActor: { kind, ref },
    causedByEventId: 'attempt_source_1',
  };
}

describe('agent-note DomainTools (YUK-293)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('declares a bounded local read/write pair on the hint channel', () => {
    expect(readAgentNotesTool).toMatchObject({
      name: 'read_agent_notes',
      effect: 'read',
      costClass: 'local',
      mirrorEvent: 'when_causal',
    });
    expect(writeAgentNoteTool).toMatchObject({
      name: 'write_agent_note',
      effect: 'write',
      costClass: 'local',
      mirrorEvent: 'when_causal',
    });
    expect(() =>
      writeAgentNoteTool.inputSchema.parse({
        target_agents: ['coach', 'coach'],
        summary_md: 'duplicate targets',
        signal_kind: 'pattern_hint',
      }),
    ).toThrow();
  });

  it('lets Copilot leave a 30-day expiring, evidence-linked hint that Coach can read', async () => {
    const before = Date.now();
    const input = writeAgentNoteTool.inputSchema.parse({
      target_agents: ['coach'],
      summary_md: '用户连续把必要条件当成充分条件，下一轮可优先核验。',
      signal_kind: 'misconception',
      refs: [{ kind: 'attempt', id: 'attempt_source_1' }],
      confidence: 0.75,
    });
    const written = await writeAgentNoteTool.execute(context('agent:copilot'), input);
    const after = Date.now();
    expect(writeAgentNoteTool.outputSchema.parse(written)).toEqual(written);
    expect(new Date(written.expires_at).getTime()).toBeGreaterThanOrEqual(
      before + 30 * 24 * 60 * 60 * 1_000,
    );
    expect(new Date(written.expires_at).getTime()).toBeLessThanOrEqual(
      after + 30 * 24 * 60 * 60 * 1_000,
    );

    const [row] = await testDb().select().from(event).where(eq(event.id, written.note_id));
    expect(row.actor_ref).toBe('copilot');
    expect(row.caused_by_event_id).toBe('attempt_source_1');
    expect(row.task_run_id).toBe('run_agent_copilot');

    const read = await readAgentNotesTool.execute(
      context('coach'),
      readAgentNotesTool.inputSchema.parse({ for_agent: 'coach', limit: 5 }),
    );
    expect(readAgentNotesTool.outputSchema.parse(read)).toEqual(read);
    expect(read.notes).toHaveLength(1);
    expect(read.notes[0]).toMatchObject({
      id: written.note_id,
      source_task_kind: 'copilot',
      signal_kind: 'misconception',
      refs: [{ kind: 'attempt', id: 'attempt_source_1' }],
    });
  });

  it('does not feed an agent its own prior notes back as fresh evidence', async () => {
    await writeAgentNote(testDb(), {
      target_agents: ['dreaming'],
      source_task_kind: 'dreaming',
      refs: [{ kind: 'attempt', id: 'attempt_1' }],
      summary_md: 'self-authored hint',
      signal_kind: 'pattern_hint',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const read = await readAgentNotesTool.execute(
      context('dreaming'),
      readAgentNotesTool.inputSchema.parse({ for_agent: 'dreaming' }),
    );
    expect(read.notes).toEqual([]);
  });

  it('rejects non-agent writers and already-expired notes', async () => {
    const validBase = {
      target_agents: ['copilot'] as const,
      summary_md: 'hint',
      signal_kind: 'pattern_hint',
      refs: [],
    };
    await expect(
      writeAgentNoteTool.execute(
        context('debug:user', 'user'),
        writeAgentNoteTool.inputSchema.parse(validBase),
      ),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(
      writeAgentNoteTool.execute(
        context('coach'),
        writeAgentNoteTool.inputSchema.parse({
          ...validBase,
          expires_at: '2020-01-01T00:00:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_error', status: 400 });
  });
});

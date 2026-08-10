import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifact, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  NOTE_GENERATION_SINGLETON_SECONDS,
  NOTE_HANDOFF_ACTION,
  NOTE_HANDOFF_KINDS,
  dispatchNoteGeneration,
  dispatchNoteVerification,
  noteHandoffEventId,
  noteHandoffJobId,
  recoverNoteHandoffs,
  recoverNoteHandoffsAndClaims,
  writeNoteGenerationIntent,
  writeNoteVerificationIntent,
} from './note-handoff';

async function seedNote(
  id: string,
  states: {
    readonly generation: string;
    readonly verification: string;
    readonly archived?: boolean;
    readonly type?: string;
  },
): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: states.type ?? 'note_atomic',
      title: `Durable handoff ${id}`,
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: states.generation === 'ready' ? { type: 'doc', content: [] } : null,
      attrs: {},
      tool_kind: null,
      tool_state: null,
      generation_status: states.generation,
      verification_status: states.verification,
      generated_by: null,
      history: [],
      archived_at: states.archived ? now : null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

function fakeBoss() {
  const jobs = new Map<string, { readonly state: string }>();
  const send = vi.fn(
    async (
      _queue: string,
      _data: object,
      options: { id: string; singletonKey?: string; singletonSeconds?: number },
    ) => {
      jobs.set(options.id, { state: 'created' });
      return options.id;
    },
  );
  const getJobById = vi.fn(async (_queue: string, id: string) => jobs.get(id) ?? null);
  return { jobs, send, getJobById };
}

describe('Notes durable handoff', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes completion only after deterministic queue confirmation and is duplicate-safe', async () => {
    await seedNote('note-generation', { generation: 'pending', verification: 'not_required' });
    await testDb().transaction((tx) => writeNoteGenerationIntent(tx, 'note-generation'));
    const boss = fakeBoss();

    await expect(dispatchNoteGeneration(testDb(), 'note-generation', { boss })).resolves.toBe(true);
    await expect(dispatchNoteGeneration(testDb(), 'note-generation', { boss })).resolves.toBe(
      false,
    );

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      'note_generate',
      { artifact_id: 'note-generation' },
      {
        id: noteHandoffJobId(NOTE_HANDOFF_KINDS.generationIntent, 'note-generation'),
        singletonKey: 'note-generation',
        singletonSeconds: NOTE_GENERATION_SINGLETON_SECONDS,
      },
    );
    const completion = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(
        eq(
          event.id,
          noteHandoffEventId(NOTE_HANDOFF_KINDS.generationDispatchComplete, 'note-generation'),
        ),
      );
    expect(completion).toHaveLength(1);
  });

  it('keeps verification dispatch id-only', async () => {
    await seedNote('note-verification', { generation: 'ready', verification: 'queued' });
    await testDb().transaction((tx) => writeNoteVerificationIntent(tx, 'note-verification'));
    const boss = fakeBoss();

    await expect(dispatchNoteVerification(testDb(), 'note-verification', { boss })).resolves.toBe(
      true,
    );

    expect(boss.send).toHaveBeenCalledWith(
      'note_verify',
      { artifact_id: 'note-verification' },
      { id: noteHandoffJobId(NOTE_HANDOFF_KINDS.verificationIntent, 'note-verification') },
    );
  });

  it('does not expose an intent from a rolled-back artifact transaction', async () => {
    await expect(
      testDb().transaction(async (tx) => {
        const now = new Date();
        await tx.insert(artifact).values({
          id: 'note-rollback',
          type: 'note_atomic',
          title: 'Durable handoff note-rollback',
          parent_artifact_id: null,
          knowledge_ids: [],
          intent_source: 'learning_intent',
          source: 'ai_generated',
          source_ref: null,
          body_blocks: null,
          attrs: {},
          tool_kind: null,
          tool_state: null,
          generation_status: 'pending',
          verification_status: 'not_required',
          generated_by: null,
          history: [],
          created_at: now,
          updated_at: now,
          version: 0,
        });
        await writeNoteGenerationIntent(tx, 'note-rollback');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const artifacts = await testDb()
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.id, 'note-rollback'));
    const rows = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(
        eq(event.id, noteHandoffEventId(NOTE_HANDOFF_KINDS.generationIntent, 'note-rollback')),
      );
    expect(artifacts).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it('concurrent dispatchers converge on one deterministic job and completion', async () => {
    await seedNote('note-concurrent', { generation: 'pending', verification: 'not_required' });
    await testDb().transaction((tx) => writeNoteGenerationIntent(tx, 'note-concurrent'));
    const boss = fakeBoss();
    const results = await Promise.all([
      dispatchNoteGeneration(testDb(), 'note-concurrent', { boss }),
      dispatchNoteGeneration(testDb(), 'note-concurrent', { boss }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(boss.jobs.size).toBe(1);
    const completions = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(
        eq(
          event.id,
          noteHandoffEventId(NOTE_HANDOFF_KINDS.generationDispatchComplete, 'note-concurrent'),
        ),
      );
    expect(completions).toHaveLength(1);
  });

  it('confirms a lost send acknowledgement by deterministic job readback', async () => {
    await seedNote('note-lost-ack', { generation: 'pending', verification: 'not_required' });
    await testDb().transaction((tx) => writeNoteGenerationIntent(tx, 'note-lost-ack'));
    const boss = fakeBoss();
    boss.send.mockImplementationOnce(async (_queue, _data, options) => {
      boss.jobs.set(options.id, { state: 'created' });
      throw new Error('connection reset after commit');
    });

    await expect(dispatchNoteGeneration(testDb(), 'note-lost-ack', { boss })).resolves.toBe(true);
    expect(boss.getJobById).toHaveBeenCalledWith(
      'note_generate',
      noteHandoffJobId(NOTE_HANDOFF_KINDS.generationIntent, 'note-lost-ack'),
    );
  });

  it('does not redispatch a completion committed before recovery', async () => {
    await seedNote('note-completed-before-recovery', {
      generation: 'pending',
      verification: 'not_required',
    });
    await testDb().transaction((tx) =>
      writeNoteGenerationIntent(tx, 'note-completed-before-recovery'),
    );
    const firstBoss = fakeBoss();
    await dispatchNoteGeneration(testDb(), 'note-completed-before-recovery', { boss: firstBoss });
    const recoveryBoss = fakeBoss();
    await expect(recoverNoteHandoffs(testDb(), { boss: recoveryBoss })).resolves.toBe(0);
    expect(recoveryBoss.send).not.toHaveBeenCalled();
  });

  it('recovers current incomplete intents and synthesizes both legacy lifecycle intents', async () => {
    await seedNote('note-current', { generation: 'pending', verification: 'not_required' });
    await seedNote('note-legacy-generation', {
      generation: 'pending',
      verification: 'not_required',
    });
    await seedNote('note-legacy-verification', { generation: 'ready', verification: 'queued' });
    await testDb().transaction((tx) => writeNoteGenerationIntent(tx, 'note-current'));
    const boss = fakeBoss();

    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(3);

    const rows = await testDb()
      .select({ subject_id: event.subject_id, payload: event.payload })
      .from(event)
      .where(eq(event.action, NOTE_HANDOFF_ACTION));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject_id: 'note-legacy-generation',
          payload: expect.objectContaining({ handoff_kind: 'generation_intent', version: 1 }),
        }),
        expect.objectContaining({
          subject_id: 'note-legacy-verification',
          payload: expect.objectContaining({ handoff_kind: 'verification_intent', version: 1 }),
        }),
      ]),
    );
  });

  it('does not synthesize or dispatch handoff work for an archived pending artifact', async () => {
    await seedNote('note-archived-legacy', {
      generation: 'pending',
      verification: 'not_required',
      archived: true,
    });
    const boss = fakeBoss();

    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(0);

    expect(boss.send).not.toHaveBeenCalled();
    const intents = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(
        eq(
          event.id,
          noteHandoffEventId(NOTE_HANDOFF_KINDS.generationIntent, 'note-archived-legacy'),
        ),
      );
    expect(intents).toEqual([]);
  });

  it('does not synthesize or dispatch generation or verification work for tool artifacts', async () => {
    await seedNote('tool-pending', {
      type: 'tool_quiz',
      generation: 'pending',
      verification: 'not_required',
    });
    await seedNote('tool-ready', {
      type: 'tool_quiz',
      generation: 'ready',
      verification: 'queued',
    });
    const boss = fakeBoss();

    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(0);

    expect(boss.send).not.toHaveBeenCalled();
    const intents = await testDb()
      .select({ subjectId: event.subject_id })
      .from(event)
      .where(eq(event.action, NOTE_HANDOFF_ACTION));
    expect(intents).toEqual([]);
  });

  it('does not dispatch stale generation or verification intents for tool artifacts', async () => {
    await seedNote('tool-with-intent', {
      type: 'tool_quiz',
      generation: 'pending',
      verification: 'not_required',
    });
    await seedNote('tool-verify-with-intent', {
      type: 'tool_quiz',
      generation: 'ready',
      verification: 'queued',
    });
    await testDb().transaction(async (tx) => {
      await writeNoteGenerationIntent(tx, 'tool-with-intent');
      await writeNoteVerificationIntent(tx, 'tool-verify-with-intent');
    });
    const boss = fakeBoss();

    await expect(dispatchNoteGeneration(testDb(), 'tool-with-intent', { boss })).resolves.toBe(
      false,
    );
    await expect(
      dispatchNoteVerification(testDb(), 'tool-verify-with-intent', { boss }),
    ).resolves.toBe(false);
    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(0);

    expect(boss.send).not.toHaveBeenCalled();
  });

  it('does not dispatch an existing intent after its artifact is archived', async () => {
    await seedNote('note-archived-after-intent', {
      generation: 'pending',
      verification: 'not_required',
    });
    await testDb().transaction((tx) => writeNoteGenerationIntent(tx, 'note-archived-after-intent'));
    await testDb()
      .update(artifact)
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where(eq(artifact.id, 'note-archived-after-intent'));
    const boss = fakeBoss();

    await expect(
      dispatchNoteGeneration(testDb(), 'note-archived-after-intent', { boss }),
    ).resolves.toBe(false);
    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(0);

    expect(boss.send).not.toHaveBeenCalled();
  });

  it('skips malformed, future-version, missing and terminal rows without blocking valid work', async () => {
    await seedNote('note-valid', { generation: 'pending', verification: 'not_required' });
    await seedNote('note-terminal', { generation: 'failed', verification: 'failed' });
    await testDb().transaction(async (tx) => {
      await writeNoteGenerationIntent(tx, 'note-valid');
      await writeEvent(tx, {
        id: 'malformed-handoff',
        actor_kind: 'system',
        actor_ref: 'test',
        action: NOTE_HANDOFF_ACTION,
        subject_kind: 'artifact',
        subject_id: 'missing-artifact',
        payload: { version: 1, handoff_kind: 'generation_intent' },
      });
      await writeEvent(tx, {
        id: 'future-handoff',
        actor_kind: 'system',
        actor_ref: 'test',
        action: NOTE_HANDOFF_ACTION,
        subject_kind: 'artifact',
        subject_id: 'note-terminal',
        payload: {
          version: 2,
          artifact_id: 'note-terminal',
          handoff_kind: 'generation_intent',
        },
      });
    });
    const boss = fakeBoss();

    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(1);
    expect(boss.send).toHaveBeenCalledTimes(1);
  });

  it('filters fifty terminal intents before the recovery limit', async () => {
    for (let index = 0; index < 50; index += 1) {
      const artifactId = `terminal-intent-${String(index).padStart(2, '0')}`;
      await seedNote(artifactId, { generation: 'failed', verification: 'failed' });
      await testDb().transaction((tx) => writeNoteGenerationIntent(tx, artifactId));
    }
    await seedNote('valid-after-terminal-intents', {
      generation: 'pending',
      verification: 'not_required',
    });
    await testDb().transaction((tx) =>
      writeNoteGenerationIntent(tx, 'valid-after-terminal-intents'),
    );
    const boss = fakeBoss();

    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(1);

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      'note_generate',
      { artifact_id: 'valid-after-terminal-intents' },
      {
        id: noteHandoffJobId(NOTE_HANDOFF_KINDS.generationIntent, 'valid-after-terminal-intents'),
        singletonKey: 'valid-after-terminal-intents',
        singletonSeconds: NOTE_GENERATION_SINGLETON_SECONDS,
      },
    );
  });

  it('filters fifty non-note intents before the recovery limit', async () => {
    for (let index = 0; index < 50; index += 1) {
      const artifactId = `tool-poison-${String(index).padStart(2, '0')}`;
      await seedNote(artifactId, {
        type: 'tool_quiz',
        generation: 'pending',
        verification: 'not_required',
      });
      await testDb().transaction((tx) => writeNoteGenerationIntent(tx, artifactId));
    }
    await seedNote('note-after-tool-poison', {
      generation: 'pending',
      verification: 'not_required',
    });
    const boss = fakeBoss();

    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(1);

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      'note_generate',
      { artifact_id: 'note-after-tool-poison' },
      {
        id: noteHandoffJobId(NOTE_HANDOFF_KINDS.generationIntent, 'note-after-tool-poison'),
        singletonKey: 'note-after-tool-poison',
        singletonSeconds: NOTE_GENERATION_SINGLETON_SECONDS,
      },
    );
  });

  it('filters fifty non-note lifecycle rows before legacy synthesis limit', async () => {
    for (let index = 0; index < 50; index += 1) {
      await seedNote(`tool-legacy-${String(index).padStart(2, '0')}`, {
        type: 'tool_quiz',
        generation: 'pending',
        verification: 'not_required',
      });
    }
    await seedNote('note-after-tool-legacy', {
      generation: 'pending',
      verification: 'not_required',
    });
    const boss = fakeBoss();

    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(1);

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      'note_generate',
      { artifact_id: 'note-after-tool-legacy' },
      {
        id: noteHandoffJobId(NOTE_HANDOFF_KINDS.generationIntent, 'note-after-tool-legacy'),
        singletonKey: 'note-after-tool-legacy',
        singletonSeconds: NOTE_GENERATION_SINGLETON_SECONDS,
      },
    );
  });

  it('filters fifty payload-subject mismatches before the recovery limit', async () => {
    await seedNote('note-after-poison', { generation: 'pending', verification: 'not_required' });
    await testDb().transaction(async (tx) => {
      await writeNoteGenerationIntent(tx, 'note-after-poison');
      for (let index = 0; index < 50; index += 1) {
        await writeEvent(tx, {
          id: `poison-${String(index).padStart(2, '0')}`,
          actor_kind: 'system',
          actor_ref: 'test',
          action: NOTE_HANDOFF_ACTION,
          subject_kind: 'artifact',
          subject_id: 'note-after-poison',
          payload: {
            version: 1,
            artifact_id: `mismatch-${index}`,
            handoff_kind: 'generation_intent',
          },
        });
      }
    });
    const boss = fakeBoss();
    await expect(recoverNoteHandoffs(testDb(), { boss })).resolves.toBe(1);
    expect(boss.send).toHaveBeenCalledTimes(1);
  });

  it('recovers an intent left incomplete by an after-commit dispatch crash', async () => {
    await seedNote('note-crash-window', { generation: 'pending', verification: 'not_required' });
    await testDb().transaction((tx) => writeNoteGenerationIntent(tx, 'note-crash-window'));
    const unavailableBoss = fakeBoss();
    unavailableBoss.send.mockRejectedValueOnce(new Error('boss unavailable'));
    unavailableBoss.getJobById.mockRejectedValueOnce(new Error('boss unavailable'));
    await expect(
      dispatchNoteGeneration(testDb(), 'note-crash-window', { boss: unavailableBoss }),
    ).rejects.toThrow('boss unavailable');
    const recoveredBoss = fakeBoss();
    await expect(recoverNoteHandoffs(testDb(), { boss: recoveredBoss })).resolves.toBe(1);
  });

  it('attempts claim recovery when handoff recovery fails, then rejects for retry', async () => {
    const handoffError = new Error('handoff recovery failed');
    const recoverHandoffs = vi.fn(async (): Promise<number> => {
      throw handoffError;
    });
    const recoverClaims = vi.fn(async () => 0);

    await expect(
      recoverNoteHandoffsAndClaims(testDb(), { recoverHandoffs, recoverClaims }),
    ).rejects.toBe(handoffError);
    expect(recoverHandoffs).toHaveBeenCalledTimes(1);
    expect(recoverClaims).toHaveBeenCalledTimes(1);
  });

  it('attempts handoff recovery when claim recovery fails, then rejects for retry', async () => {
    const claimError = new Error('claim recovery failed');
    const recoverHandoffs = vi.fn(async () => 0);
    const recoverClaims = vi.fn(async (): Promise<number> => {
      throw claimError;
    });

    await expect(
      recoverNoteHandoffsAndClaims(testDb(), { recoverHandoffs, recoverClaims }),
    ).rejects.toBe(claimError);
    expect(recoverHandoffs).toHaveBeenCalledTimes(1);
    expect(recoverClaims).toHaveBeenCalledTimes(1);
  });
});

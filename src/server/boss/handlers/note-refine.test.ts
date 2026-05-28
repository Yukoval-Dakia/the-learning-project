import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifact, event, knowledge } from '@/db/schema';
import { noteSectionsToBodyBlocks } from '@/server/artifacts/body-blocks';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import { buildNoteRefineHandler, parseNoteRefineOutput, runNoteRefine } from './note-refine';

const ATOMIC_SECTIONS = [
  {
    id: 's1',
    kind: 'definition' as const,
    body_md: '「之」是文言虚词。',
    source_tier: 'llm_only' as const,
    user_verified: false,
    embedded_check: null,
    version: 1,
  },
  {
    id: 's2',
    kind: 'mechanism' as const,
    body_md: '助词 / 代词 / 动词三类。',
    source_tier: 'llm_only' as const,
    user_verified: false,
    embedded_check: null,
    version: 1,
  },
];

function paragraphBlock(id: string, text: string) {
  return {
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  };
}

async function seedArtifact(opts: {
  artifactId: string;
  knowledgeId?: string;
  // Use { bodyBlocks: null } explicitly to seed a null body_blocks row;
  // omitting the key falls back to the default atomic doc. Distinguishing
  // explicit-null vs omitted matters because `??` would collapse them.
  bodyBlocks?: unknown;
  artifactType?: 'note_atomic' | 'note_long' | 'note_hub';
}) {
  const db = testDb();
  const now = new Date();
  if (opts.knowledgeId) {
    await db.insert(knowledge).values({
      id: opts.knowledgeId,
      name: '之',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
  const bodyBlocks = Object.hasOwn(opts, 'bodyBlocks')
    ? opts.bodyBlocks
    : noteSectionsToBodyBlocks(ATOMIC_SECTIONS);
  await db.insert(artifact).values({
    id: opts.artifactId,
    type: opts.artifactType ?? 'note_atomic',
    title: '之的用法',
    parent_artifact_id: null,
    knowledge_ids: opts.knowledgeId ? [opts.knowledgeId] : [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    body_blocks: bodyBlocks as never,
    attrs: { one_line_intent: '区分关键用法' } as never,
    tool_kind: null,
    tool_state: null,
    generation_status: 'ready',
    verification_status: 'verified',
    verification_summary: null,
    generated_by: { by: 'ai', task_kind: 'NoteGenerateTask' } as never,
    verified_by: null,
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

function refinePayload(ops: unknown[]) {
  return JSON.stringify({ ops });
}

describe('parseNoteRefineOutput', () => {
  it('parses a valid NotePatch JSON', () => {
    const out = parseNoteRefineOutput(
      refinePayload([{ kind: 'append_block', block: paragraphBlock('b9', 'hi') }]),
    );
    expect(out.patch.ops).toHaveLength(1);
    expect(out.patch.ops[0].kind).toBe('append_block');
  });

  it('throws when no JSON object found', () => {
    expect(() => parseNoteRefineOutput('no json here')).toThrow(/no JSON object found/);
  });

  it('throws when JSON is invalid', () => {
    expect(() => parseNoteRefineOutput('{not json}')).toThrow(/JSON\.parse failed/);
  });

  it('throws when ops fail schema validation', () => {
    expect(() =>
      parseNoteRefineOutput(refinePayload([{ kind: 'bogus_kind', target_block_id: 'b1' }])),
    ).toThrow(/schema invalid/);
  });
});

describe('runNoteRefine', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns skipped:not_found when artifact missing', async () => {
    const runTaskFn = vi.fn();
    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'missing',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
    });
    expect(result.status).toBe('skipped:not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:no_body_blocks when artifact has null body_blocks', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1', bodyBlocks: null });
    const runTaskFn = vi.fn();
    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
    });
    expect(result.status).toBe('skipped:no_body_blocks');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:empty_patch when AI emits empty ops (no event written)', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: refinePayload([]) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
    });
    expect(result.status).toBe('skipped:empty_patch');
    const rows = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(rows).toHaveLength(0);
  });

  it('mutator path: applies patch, bumps artifact.version, writes note_refine_apply event', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const ops = [{ kind: 'append_block', block: paragraphBlock('b_new', '新加段落') }];
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(ops) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
    });

    expect(result).toMatchObject({
      status: 'applied',
      ops_count: 1,
      new_blocks: 1,
    });

    const [updated] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updated.version).toBe(1);
    const content = (
      updated.body_blocks as unknown as {
        content: { attrs: { id: string } }[];
      }
    ).content;
    expect(content.some((n) => n.attrs.id === 'b_new')).toBe(true);

    const events = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'experimental:note_refine_apply',
      subject_kind: 'artifact',
      outcome: 'success',
      actor_kind: 'agent',
      actor_ref: 'note_refine',
    });
    const payload = events[0].payload as {
      ops_count: number;
      new_blocks: number;
      previous_artifact_version: number;
      next_artifact_version: number;
    };
    expect(payload).toMatchObject({
      ops_count: 1,
      new_blocks: 1,
      previous_artifact_version: 0,
      next_artifact_version: 1,
    });
  });

  it('chains caused_by_event_id to trigger_event_id when provided', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const ops = [{ kind: 'append_block', block: paragraphBlock('b_new', 'x') }];
    const runTaskFn = vi.fn(async () => ({
      text: refinePayload(ops),
      task_run_id: 'run_xyz',
      cost_usd: 0.0005,
    }));

    // seed a fake trigger event row so caused_by_event_id FK satisfies — easiest:
    // use a self-referential dummy attempt event.
    const triggerId = 'evt_trigger_demo';
    await testDb()
      .insert(event)
      .values({
        id: triggerId,
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        outcome: 'failure',
        payload: { answer_md: null, answer_image_refs: [], referenced_knowledge_ids: [] },
        caused_by_event_id: null,
        affected_scopes: ['global'],
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });

    await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong', trigger_event_id: triggerId },
      runTaskFn,
    });

    const events = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_apply'));
    expect(events).toHaveLength(1);
    expect(events[0].caused_by_event_id).toBe(triggerId);
    expect(events[0].task_run_id).toBe('run_xyz');
    expect(events[0].cost_micro_usd).toBe(500);
  });

  it('propose path: gate returns "propose", onPropose called, no event written', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const ops = [
      { kind: 'append_block', block: paragraphBlock('b1', 'x') },
      { kind: 'append_block', block: paragraphBlock('b2', 'y') },
      { kind: 'append_block', block: paragraphBlock('b3', 'z') },
      { kind: 'append_block', block: paragraphBlock('b4', 'w') },
    ];
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(ops) }));
    const onPropose = vi.fn(async () => {});
    const gate = vi.fn(() => 'propose' as const);

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
      gate,
      onPropose,
    });

    expect(result).toMatchObject({ status: 'proposed', ops_count: 4, new_blocks: 4 });
    expect(gate).toHaveBeenCalledWith({ ops_count: 4, new_blocks: 4 });
    expect(onPropose).toHaveBeenCalledOnce();

    // No apply happened: artifact.version unchanged, no event row.
    const [unchanged] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(unchanged.version).toBe(0);
    const rows = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(rows).toHaveLength(0);
  });

  it('rethrows when AI output is unparseable (no partial DB state)', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: 'not json' }));

    await expect(
      runNoteRefine({
        db: testDb(),
        artifactId: 'a1',
        trigger: { kind: 'mark_wrong' },
        runTaskFn,
      }),
    ).rejects.toThrow(/parseNoteRefineOutput|no JSON object/);

    const [unchanged] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(unchanged.version).toBe(0);
  });

  it('passes subject profile resolved from knowledge.domain to NoteRefineTask', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: refinePayload([]) }));

    await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'dreaming', context_md: 'maintenance scan' },
      runTaskFn,
    });

    expect(runTaskFn).toHaveBeenCalledWith(
      'NoteRefineTask',
      expect.objectContaining({
        artifact_id: 'a1',
        trigger: expect.objectContaining({ kind: 'dreaming', context_md: 'maintenance scan' }),
      }),
      expect.objectContaining({
        subjectProfile: expect.objectContaining({ id: 'wenyan' }),
      }),
    );
  });
});

describe('buildNoteRefineHandler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('runs runNoteRefine for each job', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({
      text: refinePayload([{ kind: 'append_block', block: paragraphBlock('b_handler', 'x') }]),
    }));
    const handler = buildNoteRefineHandler(testDb(), { runTaskFn });
    await handler([
      {
        id: 'j1',
        data: { artifact_id: 'a1', trigger: { kind: 'mark_wrong' } },
      } as never,
    ]);
    const rows = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_apply'));
    expect(rows).toHaveLength(1);
  });

  it('skips jobs missing artifact_id or trigger.kind without throwing', async () => {
    const runTaskFn = vi.fn();
    const handler = buildNoteRefineHandler(testDb(), { runTaskFn });
    await handler([
      { id: 'j1', data: { artifact_id: '', trigger: { kind: 'mark_wrong' } } } as never,
      { id: 'j2', data: { artifact_id: 'a1' } } as never,
    ]);
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('rethrows runner errors so pg-boss retries per queue policy', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: 'broken json' }));
    const handler = buildNoteRefineHandler(testDb(), { runTaskFn });
    await expect(
      handler([
        { id: 'j1', data: { artifact_id: 'a1', trigger: { kind: 'mark_wrong' } } } as never,
      ]),
    ).rejects.toThrow();
  });
});

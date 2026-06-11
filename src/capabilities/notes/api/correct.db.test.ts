import { noteSectionsToBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import { artifact } from '@/db/schema';
import { getArtifactCorrectionState } from '@/server/events/artifact-corrections';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET, POST } from './correct';

const NOTE_SECTIONS = [
  {
    id: 's_def',
    kind: 'definition',
    body_md: 'definition body',
    source_tier: 'llm_only',
    user_verified: false,
    embedded_check: null,
    version: 1,
  },
  {
    id: 's_pitfall',
    kind: 'pitfall',
    body_md: 'pitfall body',
    source_tier: 'llm_only',
    user_verified: false,
    embedded_check: null,
    version: 1,
  },
];

async function seedAtomic(
  artifactId: string,
  opts?: { sections?: unknown[] | null; bodyBlocks?: unknown },
) {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id: artifactId,
    type: 'note_atomic',
    title: '测试 atomic',
    parent_artifact_id: null,
    knowledge_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    body_blocks:
      opts?.bodyBlocks !== undefined
        ? (opts.bodyBlocks as never)
        : opts?.sections === null
          ? null
          : noteSectionsToBodyBlocks(
              (opts?.sections === undefined ? NOTE_SECTIONS : opts.sections) as never,
            ),
    attrs: { one_line_intent: 'test' } as never,
    tool_kind: null,
    tool_state: null,
    generation_status: 'ready',
    verification_status: 'queued',
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

async function postCorrect(artifactId: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/artifacts/${artifactId}/correct`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { id: artifactId },
  );
}

async function getCorrect(artifactId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/artifacts/${artifactId}/correct`), {
    id: artifactId,
  });
}

describe('POST /api/artifacts/[id]/correct', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a whole-artifact mark_wrong event and updates projection state', async () => {
    await seedAtomic('artifact_42');

    const res = await postCorrect('artifact_42', {
      correction_kind: 'mark_wrong',
      reason_md: 'This whole atomic misstates the rule.',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correction_event_id: string };
    expect(body.correction_event_id).toBeTypeOf('string');

    const state = await getArtifactCorrectionState(testDb(), 'artifact_42');
    expect(state.whole.state).toBe('marked_wrong');
    expect(state.whole.correction_event_id).toBe(body.correction_event_id);
    expect(state.blocks.size).toBe(0);
  });

  it('writes a block-scoped mark_wrong event when block_id resolves to a real block', async () => {
    await seedAtomic('artifact_42');

    const res = await postCorrect('artifact_42', {
      correction_kind: 'mark_wrong',
      block_id: 's_pitfall',
      reason_md: 'pitfall is wrong about negation.',
    });
    expect(res.status).toBe(200);

    const state = await getArtifactCorrectionState(testDb(), 'artifact_42');
    expect(state.whole.state).toBe('active');
    expect(state.blocks.get('s_pitfall')?.state).toBe('marked_wrong');
    expect(state.blocks.get('s_def')).toBeUndefined();
  });

  it('accepts correction targets on non-semantic body_blocks nodes', async () => {
    await seedAtomic('artifact_42', {
      bodyBlocks: {
        type: 'doc',
        content: [
          {
            type: 'calloutBlock',
            attrs: { id: 'callout_1', tone: 'warn', title: '注意' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '这里有误' }] }],
          },
        ],
      },
    });

    const res = await postCorrect('artifact_42', {
      correction_kind: 'mark_wrong',
      block_id: 'callout_1',
      reason_md: 'callout itself is wrong.',
    });
    expect(res.status).toBe(200);

    const state = await getArtifactCorrectionState(testDb(), 'artifact_42');
    expect(state.blocks.get('callout_1')?.state).toBe('marked_wrong');
  });

  it('returns 404 when artifact does not exist', async () => {
    const res = await postCorrect('artifact_missing', {
      correction_kind: 'mark_wrong',
      reason_md: 'never seen this artifact.',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when block_id is not present in artifact body_blocks', async () => {
    await seedAtomic('artifact_42');

    const res = await postCorrect('artifact_42', {
      correction_kind: 'mark_wrong',
      block_id: 's_nonexistent',
      reason_md: 'targeting a block that does not exist.',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when artifact.body_blocks is null and block_id is provided', async () => {
    await seedAtomic('artifact_42', { sections: null });

    const res = await postCorrect('artifact_42', {
      correction_kind: 'mark_wrong',
      block_id: 's_anything',
      reason_md: 'blocks not yet generated.',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when body validation fails (empty reason_md)', async () => {
    await seedAtomic('artifact_42');

    const res = await postCorrect('artifact_42', {
      correction_kind: 'mark_wrong',
      reason_md: '',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when supersede omits replacement_artifact_id (superRefine)', async () => {
    await seedAtomic('artifact_old');

    const res = await postCorrect('artifact_old', {
      correction_kind: 'supersede',
      reason_md: 'supersede must carry replacement_artifact_id.',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when supersede replacement_artifact_id does not exist', async () => {
    await seedAtomic('artifact_old');

    const res = await postCorrect('artifact_old', {
      correction_kind: 'supersede',
      reason_md: 'replacement points at nothing.',
      replacement_artifact_id: 'artifact_does_not_exist',
    });
    expect(res.status).toBe(404);
  });

  it('writes a supersede event with valid replacement and updates projection', async () => {
    await seedAtomic('artifact_old');
    await seedAtomic('artifact_new');

    const res = await postCorrect('artifact_old', {
      correction_kind: 'supersede',
      reason_md: 'Atomic refined; superseded by next version.',
      replacement_artifact_id: 'artifact_new',
    });
    expect(res.status).toBe(200);

    const state = await getArtifactCorrectionState(testDb(), 'artifact_old');
    expect(state.whole.state).toBe('superseded');
    expect(state.whole.replacement_artifact_id).toBe('artifact_new');
  });
});

describe('GET /api/artifacts/[id]/correct', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns whole=active and empty blocks when artifact has no corrections', async () => {
    await seedAtomic('artifact_42');

    const res = await getCorrect('artifact_42');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact_id: string;
      whole: { state: string };
      blocks: Record<string, { state: string }>;
    };
    expect(body.artifact_id).toBe('artifact_42');
    expect(body.whole.state).toBe('active');
    expect(body.blocks).toEqual({});
  });

  it('reflects a block mark_wrong written via POST', async () => {
    await seedAtomic('artifact_42');
    const post = await postCorrect('artifact_42', {
      correction_kind: 'mark_wrong',
      block_id: 's_pitfall',
      reason_md: 'pitfall is wrong',
    });
    expect(post.status).toBe(200);

    const res = await getCorrect('artifact_42');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      whole: { state: string };
      blocks: Record<string, { state: string; correction_event_id: string }>;
    };
    expect(body.whole.state).toBe('active');
    expect(body.blocks.s_pitfall?.state).toBe('marked_wrong');
    expect(body.blocks.s_pitfall?.correction_event_id).toBeTypeOf('string');
  });

  it('returns 404 when artifact does not exist', async () => {
    const res = await getCorrect('artifact_missing');
    expect(res.status).toBe(404);
  });

  it('returns whole=active and empty blocks when artifact.body_blocks is null', async () => {
    await seedAtomic('artifact_42', { sections: null });

    const res = await getCorrect('artifact_42');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      whole: { state: string };
      blocks: Record<string, unknown>;
    };
    expect(body.whole.state).toBe('active');
    expect(body.blocks).toEqual({});
  });
});

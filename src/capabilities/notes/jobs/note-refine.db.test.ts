import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { noteSectionsToBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import {
  NOTE_REFINE_ACCEPT_ACTOR,
  NOTE_REFINE_AUTOAPPLY_ACTOR,
} from '@/capabilities/notes/server/note-refine-apply';
import {
  REFINE_AUTOAPPLY_MAX,
  REFINE_AUTOAPPLY_WARN,
} from '@/capabilities/notes/server/note-refine-breaker';
import { editArtifactSection } from '@/capabilities/notes/server/sections';
import { artifact, event, knowledge } from '@/db/schema';
import {
  markArtifactIdleAndFlush,
  recordEditingHeartbeat,
  resetEditingSessionStateForTests,
} from '@/server/artifacts/editing-session';
import * as eventQueries from '@/server/events/queries';
import { writeEvent } from '@/server/events/queries';

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

// C1a (YUK-358): one section is user_verified — the AI must propose, not
// overwrite, any replace/delete of it.
const VERIFIED_SECTIONS = [
  {
    id: 'sv',
    kind: 'definition' as const,
    body_md: '人类校验过的定义。',
    source_tier: 'user_verified' as const,
    user_verified: true,
    embedded_check: null,
    version: 2,
  },
  {
    id: 'sa',
    kind: 'mechanism' as const,
    body_md: 'AI 拥有的内容。',
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

function replaceBlockOp(targetId: string, text: string) {
  return {
    kind: 'replace_block',
    target_block_id: targetId,
    block: paragraphBlock(targetId, text),
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
    await resetEditingSessionStateForTests();
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
      now: new Date('2026-05-28T12:00:10Z'),
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
      now: new Date('2026-05-28T12:00:10Z'),
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
      previous_body_blocks?: unknown;
      reverse_patch?: unknown;
    };
    expect(payload).toMatchObject({
      ops_count: 1,
      new_blocks: 1,
      previous_artifact_version: 0,
      next_artifact_version: 1,
    });
    expect(payload.previous_body_blocks).toBeTruthy();
    expect(payload.reverse_patch).toMatchObject({ kind: 'restore_body_blocks' });
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

  it('default gate: patches over the locked mutator threshold create a note_update proposal', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const ops = [
      { kind: 'append_block', block: paragraphBlock('b1', 'x') },
      { kind: 'append_block', block: paragraphBlock('b2', 'y') },
      { kind: 'append_block', block: paragraphBlock('b3', 'z') },
    ];
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(ops) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
    });

    expect(result).toMatchObject({ status: 'proposed', ops_count: 3, new_blocks: 3 });
    const [unchanged] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(unchanged.version).toBe(0);
    const proposals = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toHaveLength(1);
    expect((proposals[0].payload as { ai_proposal?: { kind?: string } }).ai_proposal?.kind).toBe(
      'note_update',
    );
  });

  // C1a (YUK-358, ADR-0040 决定1) — user_verified hard boundary divert.
  it('user_verified: a mutator-sized replace of a verified block DIVERTS to propose (body unchanged)', async () => {
    await seedArtifact({
      artifactId: 'a1',
      knowledgeId: 'k1',
      bodyBlocks: noteSectionsToBodyBlocks(VERIFIED_SECTIONS),
    });
    // 1 op, 0 new blocks → count-gate says mutator. The verified-block divert
    // must override and route to propose.
    const ops = [replaceBlockOp('sv', 'AI 想覆盖人类校验过的内容')];
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(ops) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
    });

    expect(result).toMatchObject({ status: 'proposed', ops_count: 1, new_blocks: 0 });
    // body_blocks UNCHANGED (no silent overwrite), no apply event.
    const [unchanged] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(unchanged.version).toBe(0);
    const applyEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_apply'));
    expect(applyEvents).toHaveLength(0);
    // a note_update proposal row exists (patch-carrying producer).
    const proposals = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toHaveLength(1);
    expect((proposals[0].payload as { ai_proposal?: { kind?: string } }).ai_proposal?.kind).toBe(
      'note_update',
    );
  });

  // RED-3 (YUK-358 决定7) — the verify trigger kind has ZERO privilege at the
  // gate. A mutator-sized (1 op) verify-kind refine that replaces a user-verified
  // block must STILL DIVERT to propose via patchTouchesVerifiedBlock, exactly like
  // any other kind. Proves the verify→refine path does NOT bypass the guard.
  it('verify kind: a mutator-sized replace of a verified block DIVERTS to propose (gate not bypassed)', async () => {
    await seedArtifact({
      artifactId: 'a1',
      knowledgeId: 'k1',
      bodyBlocks: noteSectionsToBodyBlocks(VERIFIED_SECTIONS),
    });
    const ops = [replaceBlockOp('sv', 'verify 想覆盖人类校验过的内容')];
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(ops) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'verify', context_md: 'Note verification flagged issues' },
      runTaskFn,
    });

    // Diverted to propose — NOT applied. verify has no special pass at the gate.
    expect(result).toMatchObject({ status: 'proposed', ops_count: 1, new_blocks: 0 });
    const [unchanged] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(unchanged.version).toBe(0);
    const applyEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_apply'));
    expect(applyEvents).toHaveLength(0);
    const proposals = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toHaveLength(1);
  });

  it('user_verified: a mutator-sized replace of a NON-verified block still AUTO-APPLIES (A档)', async () => {
    await seedArtifact({
      artifactId: 'a1',
      knowledgeId: 'k1',
      bodyBlocks: noteSectionsToBodyBlocks(VERIFIED_SECTIONS),
    });
    // Replace the NON-verified block 'sa' — same op size, must auto-apply.
    const ops = [replaceBlockOp('sa', 'AI 改自己的内容')];
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(ops) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
    });

    expect(result.status).toBe('applied');
    const [updated] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updated.version).toBe(1);
    const proposals = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toHaveLength(0);
  });

  it('setter end-to-end: a human edit upgrades a block to user_verified, then an AI replace DIVERTS to propose', async () => {
    // Seed with an AI-owned, NON-verified section.
    await seedArtifact({
      artifactId: 'a1',
      knowledgeId: 'k1',
      bodyBlocks: noteSectionsToBodyBlocks([
        {
          id: 's1',
          kind: 'definition' as const,
          body_md: 'AI 初稿。',
          source_tier: 'llm_only' as const,
          user_verified: false,
          embedded_check: null,
          version: 1,
        },
      ]),
    });

    // 1) human edits the section → implicit-on-edit setter promotes it.
    const edited = await editArtifactSection({
      db: testDb(),
      artifactId: 'a1',
      sectionId: 's1',
      expectedArtifactVersion: 0,
      expectedSectionVersion: 1,
      nextBodyMd: '人类改写后的定义。',
    });
    expect(edited.section.user_verified).toBe(true);
    expect(edited.section.source_tier).toBe('user_verified');

    // 2) an AI refine that replaces the now-verified block must DIVERT to propose
    //    (proves the guard is NOT dead code — it is live via the setter).
    const ops = [replaceBlockOp('s1', 'AI 想再覆盖')];
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(ops) }));
    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
    });

    expect(result.status).toBe('proposed');
    const proposals = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toHaveLength(1);
    // artifact body still holds the human's text (no AI overwrite).
    const [art] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    const content = (art.body_blocks as { content: Array<{ attrs?: { id?: string } }> }).content;
    const s1 = content.find((node) => node.attrs?.id === 's1');
    expect((s1 as { attrs?: { source_markdown?: string } }).attrs?.source_markdown).toBe(
      '人类改写后的定义。',
    );
  });

  it('mutator path defers while the artifact is actively edited and flushes on idle', async () => {
    await seedArtifact({ artifactId: 'a1', knowledgeId: 'k1' });
    const now = new Date('2026-05-28T12:00:00Z');
    await recordEditingHeartbeat({ artifactId: 'a1', status: 'editing', now });
    const runTaskFn = vi.fn(async () => ({
      text: refinePayload([{ kind: 'append_block', block: paragraphBlock('b_deferred', 'x') }]),
    }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a1',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
      now: new Date('2026-05-28T12:00:10Z'),
    });

    expect(result).toMatchObject({ status: 'deferred', ops_count: 1, new_blocks: 1 });
    const [unchanged] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(unchanged.version).toBe(0);

    const flush = await markArtifactIdleAndFlush({
      db: testDb(),
      artifactId: 'a1',
      now: new Date('2026-05-28T12:00:10Z'),
    });

    expect(flush.flushed).toBe(1);
    const [updated] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updated.version).toBe(1);
    const content = (
      updated.body_blocks as unknown as {
        content: { attrs: { id: string } }[];
      }
    ).content;
    expect(content.some((n) => n.attrs.id === 'b_deferred')).toBe(true);
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
        // YUK-228 (S3 Slice B): handler must pass resolveNoteSkill(subject) as skills.
        skills: ['note-wenyan'],
      }),
    );
  });
});

// YUK-358 / ADR-0040 决定1 — A-track auto-apply rate breaker. A mutator-eligible
// patch (1 append op → within the count gate, non-verified block) is the unit
// under test; the breaker decides ok / warned / tripped purely from the
// auto-apply rate, never touching the count/user_verified gate.
describe('runNoteRefine — A-track rate breaker', () => {
  beforeEach(async () => {
    await resetDb();
    await resetEditingSessionStateForTests();
  });

  // Seed `count` prior `experimental:note_refine_apply` events inside the window
  // (created_at = now), all by the AI mutator actor, so countRecentAutoApplies
  // returns exactly `count`.
  async function seedAutoApplyEvents(opts: {
    count: number;
    now: Date;
    actorRef?: string;
  }) {
    const db = testDb();
    for (let i = 0; i < opts.count; i++) {
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: opts.actorRef ?? NOTE_REFINE_AUTOAPPLY_ACTOR,
        action: 'experimental:note_refine_apply',
        subject_kind: 'artifact',
        // distinct subject per row so we don't depend on a real artifact existing.
        subject_id: `seed_art_${i}`,
        outcome: 'success',
        payload: {
          artifact_id: `seed_art_${i}`,
          previous_artifact_version: 0,
          next_artifact_version: 1,
          ops_count: 1,
          new_blocks: 1,
          ops: [],
          previous_body_blocks: { type: 'doc', content: [] },
          reverse_patch: { kind: 'restore_body_blocks', body_blocks: {}, artifact_version: 0 },
        },
        caused_by_event_id: null,
        created_at: opts.now,
      });
    }
  }

  const appendOps = (id: string) => [
    { kind: 'append_block', block: paragraphBlock(id, '熔断器测试段落') },
  ];

  it('under the warn water-mark → auto-applies, no warned event', async () => {
    const now = new Date('2026-06-18T12:00:00Z');
    await seedAutoApplyEvents({ count: REFINE_AUTOAPPLY_WARN - 1, now });
    await seedArtifact({ artifactId: 'a_ok', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(appendOps('b_ok')) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a_ok',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
      now,
    });

    expect(result.status).toBe('applied');
    const [art] = await testDb().select().from(artifact).where(eq(artifact.id, 'a_ok'));
    expect(art.version).toBe(1);
    const warned = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_autoapply_warned'));
    expect(warned).toHaveLength(0);
  });

  it('at the warn water-mark → STILL auto-applies + emits exactly one warned event (观测 only)', async () => {
    const now = new Date('2026-06-18T12:00:00Z');
    await seedAutoApplyEvents({ count: REFINE_AUTOAPPLY_WARN, now });
    await seedArtifact({ artifactId: 'a_warn', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(appendOps('b_warn')) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a_warn',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
      now,
    });

    // warn is observe-only: the apply STILL happens (零干预只告知).
    expect(result.status).toBe('applied');
    const [art] = await testDb().select().from(artifact).where(eq(artifact.id, 'a_warn'));
    expect(art.version).toBe(1);

    const warned = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_autoapply_warned'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      subject_kind: 'artifact',
      subject_id: 'a_warn',
      actor_ref: 'note_refine',
      outcome: 'success',
    });
    expect((warned[0].payload as { recent_count?: number }).recent_count).toBe(
      REFINE_AUTOAPPLY_WARN,
    );

    // the apply event itself was also written (warn does not suppress it).
    const applyForArt = await testDb()
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:note_refine_apply'), eq(event.subject_id, 'a_warn')),
      );
    expect(applyForArt).toHaveLength(1);
  });

  it('at the hard cap (max) → the (N+1)th refine TRIPS to propose, no apply, breaker_tripped stamped', async () => {
    const now = new Date('2026-06-18T12:00:00Z');
    // Seed a full window: exactly REFINE_AUTOAPPLY_MAX prior auto-applies.
    await seedAutoApplyEvents({ count: REFINE_AUTOAPPLY_MAX, now });
    await seedArtifact({ artifactId: 'a_trip', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(appendOps('b_trip')) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a_trip',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
      now,
    });

    expect(result.status).toBe('proposed:breaker_tripped');

    // NO apply: artifact untouched, no apply event for this artifact.
    const [art] = await testDb().select().from(artifact).where(eq(artifact.id, 'a_trip'));
    expect(art.version).toBe(0);
    const applyForArt = await testDb()
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:note_refine_apply'), eq(event.subject_id, 'a_trip')),
      );
    expect(applyForArt).toHaveLength(0);

    // a note_update proposal landed in the inbox, stamped breaker_tripped.
    const proposals = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0].payload as {
      ai_proposal?: { kind?: string; proposed_change?: { breaker_tripped?: boolean } };
    };
    expect(proposal.ai_proposal?.kind).toBe('note_update');
    expect(proposal.ai_proposal?.proposed_change?.breaker_tripped).toBe(true);
  });

  it('accept-path apply events are EXCLUDED from the rate count (only the AI mutator counts)', async () => {
    const now = new Date('2026-06-18T12:00:00Z');
    // A full window of ACCEPT-path applies (human-approved) must NOT trip the
    // breaker — they are not AI auto-applies.
    await seedAutoApplyEvents({
      count: REFINE_AUTOAPPLY_MAX,
      now,
      actorRef: NOTE_REFINE_ACCEPT_ACTOR,
    });
    await seedArtifact({ artifactId: 'a_accept', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(appendOps('b_accept')) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a_accept',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
      now,
    });

    // count of AI-mutator applies is 0 → ok → auto-applies.
    expect(result.status).toBe('applied');
    const [art] = await testDb().select().from(artifact).where(eq(artifact.id, 'a_accept'));
    expect(art.version).toBe(1);
  });

  it('injected count seam drives tripped deterministically without seeding', async () => {
    const now = new Date('2026-06-18T12:00:00Z');
    await seedArtifact({ artifactId: 'a_inj', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(appendOps('b_inj')) }));

    const result = await runNoteRefine({
      db: testDb(),
      artifactId: 'a_inj',
      trigger: { kind: 'mark_wrong' },
      runTaskFn,
      now,
      countRecentAutoApplies: async () => REFINE_AUTOAPPLY_MAX,
    });

    expect(result.status).toBe('proposed:breaker_tripped');
    const [art] = await testDb().select().from(artifact).where(eq(artifact.id, 'a_inj'));
    expect(art.version).toBe(0);
  });

  // F1 (OCR MAJOR): the warn-water-mark event is OBSERVE-ONLY (零干预只告知). If
  // its writeEvent (parseEvent schema validation + DB INSERT) throws, the apply
  // path below MUST still proceed — a telemetry hiccup must never drop a
  // user-facing refine. spyOn writeEvent so the FIRST call (the warn event) throws
  // once, then real writeEvent runs for the apply event.
  it('warn-event writeEvent throwing still lets the apply proceed (status applied)', async () => {
    const now = new Date('2026-06-18T12:00:00Z');
    await seedArtifact({ artifactId: 'a_warn_throw', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: refinePayload(appendOps('b_warn_throw')) }));

    const realWriteEvent = eventQueries.writeEvent;
    const spy = vi
      .spyOn(eventQueries, 'writeEvent')
      // first call = the observe-only warn event → throw to simulate a
      // parseEvent/INSERT failure.
      .mockImplementationOnce(async () => {
        throw new Error('simulated warn-event INSERT failure');
      })
      // every subsequent call (the apply event) = real writeEvent.
      .mockImplementation(realWriteEvent);

    try {
      const result = await runNoteRefine({
        db: testDb(),
        artifactId: 'a_warn_throw',
        trigger: { kind: 'mark_wrong' },
        runTaskFn,
        now,
        // force the warned tier deterministically without seeding a full window.
        countRecentAutoApplies: async () => REFINE_AUTOAPPLY_WARN,
      });

      // the warn-event throw was swallowed — the apply still happened.
      expect(result.status).toBe('applied');
    } finally {
      spy.mockRestore();
    }

    const [art] = await testDb().select().from(artifact).where(eq(artifact.id, 'a_warn_throw'));
    expect(art.version).toBe(1);

    // the warn event was attempted (and threw) but NOT persisted; the apply
    // event for this artifact still landed.
    const warned = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_autoapply_warned'));
    expect(warned).toHaveLength(0);
    const applyForArt = await testDb()
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:note_refine_apply'),
          eq(event.subject_id, 'a_warn_throw'),
        ),
      );
    expect(applyForArt).toHaveLength(1);
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

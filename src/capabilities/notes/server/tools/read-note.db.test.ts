import { beforeEach, describe, expect, it } from 'vitest';
import { artifact, event } from '@/db/schema';
import type { ToolContext } from '@/kernel/tools/types';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { readNoteTool } from './read-note';

const NOW = new Date('2026-11-06T00:00:00.000Z');
const LEARNER_EDIT = '2026-10-28T03:00:00.000Z';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_read_note',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

function sections(id: string, body: string, nested?: { id: string; body: string }) {
  const child = nested
    ? {
        type: 'semanticBlock',
        attrs: { id: nested.id, semantic_kind: 'example', source_markdown: nested.body },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: nested.body }] }],
      }
    : null;
  return {
    type: 'doc' as const,
    content: [
      {
        type: 'semanticBlock',
        attrs: {
          id,
          semantic_kind: 'definition',
          source_tier: 'user_verified',
          user_verified: true,
          version: 1,
          source_markdown: nested ? `${body}\n\n${nested.body}` : body,
        },
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: '标题甲' }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: body },
              { type: 'inlineMath', attrs: { latex: 'a^2' } },
            ],
          },
          {
            type: 'bulletList',
            content: ['LIST_A', 'LIST_B'].map((item) => ({
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
            })),
          },
          {
            type: 'calloutBlock',
            attrs: { title: '注意' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '看这里' }] }],
          },
          ...(child ? [child] : []),
        ],
      },
    ],
  };
}

async function seedNote(opts: {
  id: string;
  title: string;
  body: string;
  extraBody?: { id: string; body: string };
  nested?: { id: string; body: string };
  summary?: unknown;
  history?: unknown[];
}) {
  const content = sections('s1', opts.body, opts.nested);
  if (opts.extraBody) {
    const extra = sections(opts.extraBody.id, opts.extraBody.body);
    content.content = [...(content.content ?? []), ...(extra.content ?? [])];
  }
  await testDb()
    .insert(artifact)
    .values({
      id: opts.id,
      type: 'note_atomic',
      title: opts.title,
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: content as never,
      attrs: {},
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'not_required',
      verification_summary: (opts.summary ?? null) as never,
      generated_by: null,
      verified_by: null,
      history: (opts.history ?? []) as never,
      archived_at: null,
      created_at: NOW,
      updated_at: NOW,
      version: 2,
    });
}

async function seedEvent(
  id: string,
  subjectId: string,
  action: string,
  payload: unknown,
  createdAt: Date = NOW,
) {
  await testDb()
    .insert(event)
    .values({
      id,
      actor_kind: action === 'correct' ? 'user' : 'agent',
      actor_ref: action === 'correct' ? 'self' : 'note_refine',
      action,
      subject_kind: 'artifact',
      subject_id: subjectId,
      outcome: 'success',
      payload: payload as never,
      created_at: createdAt,
    });
}

describe('read_note', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant security: read_note reports this note's mark events, learner edit time, stored review issues and refine applies, and withholds retracted text
  // @fails-if a retracted child leaks, or the remaining heading, list, math, or callout is flattened to plain text
  it('counts historical marks and edits and hides retracted text', async () => {
    await seedNote({
      id: 'note-a',
      title: '二次标记',
      body: '合成定义',
      extraBody: { id: 's2', body: '块内秘密' },
      nested: { id: 's-child', body: '子树秘密' },
      summary: {
        kind: 'known_issues',
        summary_md: 'Deterministic contract check flagged 1 unresolved issue(s).',
        issues: [
          {
            block_id: null,
            severity: 'warn',
            category: 'format',
            message: 'synthetic unresolved issue',
          },
        ],
      },
      history: [
        {
          version: 1,
          at: LEARNER_EDIT,
          by: { by: 'user' },
          action: 'block_edit',
          summary_md: 'Edited block s1',
        },
        {
          version: 2,
          at: '2026-11-02T00:00:00.000Z',
          by: { by: 'ai', task_kind: 'write_note' },
          action: 'body_blocks_edit',
          summary_md: 'Appended Markdown block',
        },
      ],
    });
    await seedNote({
      id: 'note-b',
      title: '二次标记撤回',
      body: '整篇秘密',
    });
    await seedEvent('mk-1', 'note-a', 'correct', {
      correction_kind: 'mark_wrong',
      reason_md: '第一次',
    });
    await seedEvent('mk-2', 'note-a', 'correct', {
      correction_kind: 'mark_wrong',
      reason_md: '第二次',
    });
    await seedEvent('mk-restore', 'note-a', 'correct', {
      correction_kind: 'restore',
      reason_md: '收回',
    });
    await seedEvent('mk-block', 'note-a', 'correct', {
      correction_kind: 'retract',
      block_id: 's2',
      reason_md: '撤回这一块',
    });
    await seedEvent('mk-child', 'note-a', 'correct', {
      correction_kind: 'retract',
      block_id: 's-child',
      reason_md: '撤回子块',
    });
    await seedEvent('mk-other', 'note-b', 'correct', {
      correction_kind: 'mark_wrong',
      reason_md: '别篇',
    });
    await seedEvent(
      'mk-hide',
      'note-b',
      'correct',
      { correction_kind: 'retract', reason_md: '整篇撤回' },
      new Date('2026-11-06T00:01:00.000Z'),
    );
    await seedEvent('rf-a', 'note-a', 'experimental:note_refine_apply', { ops_count: 1 });
    await seedEvent('rf-b', 'note-b', 'experimental:note_refine_apply', { ops_count: 1 });

    const one = await readNoteTool.execute(ctx(), { note_id: 'note-a' });
    expect(one.notes).toEqual([
      expect.objectContaining({
        note_id: 'note-a',
        title: '二次标记',
        mark_wrong_count: 2,
        last_precise_edit_at: LEARNER_EDIT,
        pending_review_count: 1,
        refine_apply_count: 1,
        hidden: null,
        body_truncated: false,
      }),
    ]);
    const body = one.notes[0]?.body_md ?? '';
    expect(body).toContain('合成定义');
    expect(body).toContain('## 标题甲');
    expect(body).toContain('$a^2$');
    expect(body).toContain('- LIST_A\n- LIST_B');
    expect(body).toContain('注意\n\n看这里');
    expect(body).not.toContain('块内秘密');
    expect(body).not.toContain('子树秘密');

    const hidden = await readNoteTool.execute(ctx(), { note_id: 'note-b' });
    expect(hidden.notes[0]).toMatchObject({
      note_id: 'note-b',
      title: null,
      body_md: null,
      hidden: 'retracted',
      mark_wrong_count: 1,
    });
    expect(JSON.stringify(hidden)).not.toContain('整篇秘密');

    const found = await readNoteTool.execute(ctx(), { query: '二次标记' });
    const byId = new Map(found.notes.map((note) => [note.note_id, note]));
    expect(byId.get('note-a')?.body_md).toContain('## 标题甲');
    expect(byId.get('note-a')?.body_md).toContain('- LIST_A\n- LIST_B');
    expect(byId.get('note-b')?.body_md).toBeNull();
    expect(JSON.stringify(found)).not.toContain('整篇秘密');
    expect(JSON.stringify(found)).not.toContain('块内秘密');
    expect(JSON.stringify(found)).not.toContain('子树秘密');
  });
});

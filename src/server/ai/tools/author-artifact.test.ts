// ADR-0033 / YUK-306 (lane D) — author_artifact + update_artifact DomainTools
// (db partition).
//
// The load-bearing invariants: type='interactive' rows are OPAQUE to the note
// block-tree mesh (body_blocks null) and are reference-not-practice (tool_state
// null, never matched by the practice gates); cross-turn iteration reuses the
// existing artifact.version + history mechanics (body-blocks-edit.ts precedent).

import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { Artifact } from '@/core/schema';
import { INTERACTIVE_HTML_MAX_CHARS } from '@/core/schema/business';
import { artifact } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { authorArtifactTool, updateArtifactTool } from './author-artifact';
import type { ToolContext } from './types';

const HTML_V1 = '<!doctype html><html><body><h1>互动式元素周期表</h1></body></html>';
const HTML_V2 = '<!doctype html><html><body><h1>互动式元素周期表 v2</h1></body></html>';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_author_artifact',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

async function authorInteractive(
  overrides: Partial<{
    title: string;
    html: string;
    knowledge_ids: string[];
    summary: string;
  }> = {},
) {
  return authorArtifactTool.execute(ctx(), {
    type: 'interactive',
    title: '互动式元素周期表',
    html: HTML_V1,
    knowledge_ids: ['k_chem_elements'],
    summary: '可点击的周期表',
    ...overrides,
  });
}

describe('author_artifact + update_artifact DomainTools (ADR-0033 lane D)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('contract fields (both tools)', () => {
    expect(authorArtifactTool.name).toBe('author_artifact');
    expect(authorArtifactTool.effect).toBe('write');
    expect(authorArtifactTool.costClass).toBe('local');
    expect(authorArtifactTool.mirrorEvent).toBe('when_causal');
    // mcp-bridge requires a plain ZodObject inputSchema.
    expect('shape' in authorArtifactTool.inputSchema).toBe(true);
    expect(
      authorArtifactTool.summarize(
        {
          type: 'interactive',
          title: '互动式元素周期表——一个标题长到需要截断的极端例子'.repeat(3),
          html: HTML_V1,
        },
        {
          artifact_id: 'art_x'.padEnd(28, 'x'),
          type: 'interactive',
          title: 't',
          version: 0,
          knowledge_ids: [],
        },
      ).length,
    ).toBeLessThanOrEqual(120);

    expect(updateArtifactTool.name).toBe('update_artifact');
    expect(updateArtifactTool.effect).toBe('write');
    expect(updateArtifactTool.costClass).toBe('local');
    expect(updateArtifactTool.mirrorEvent).toBe('when_causal');
    expect('shape' in updateArtifactTool.inputSchema).toBe(true);
    expect(
      updateArtifactTool.summarize(
        { artifact_id: 'art_x', html: HTML_V2 },
        { artifact_id: 'art_x'.padEnd(28, 'x'), previous_version: 0, version: 1 },
      ).length,
    ).toBeLessThanOrEqual(120);
  });

  it('author happy path: opaque, reference-not-practice row shape; Artifact.parse succeeds', async () => {
    const db = testDb();
    const out = await authorInteractive();

    expect(out.type).toBe('interactive');
    expect(out.version).toBe(0);
    expect(out.knowledge_ids).toEqual(['k_chem_elements']);

    const [row] = await db.select().from(artifact).where(eq(artifact.id, out.artifact_id));
    expect(row.type).toBe('interactive');
    expect(row.title).toBe('互动式元素周期表');
    // ADR-0033 D1 — opaque to the note block-tree mesh.
    expect(row.body_blocks).toBeNull();
    // ADR-0033 — reference, not practice: no FSRS, no quiz tool_state.
    expect(row.tool_state).toBeNull();
    expect(row.intent_source).toBe('author_artifact');
    expect(row.tool_kind).toBe('author_artifact');
    expect(row.generation_status).toBe('ready');
    expect(row.verification_status).toBe('not_required');
    expect(row.history).toEqual([]);
    expect(row.version).toBe(0);
    expect(row.knowledge_ids).toEqual(['k_chem_elements']);
    const attrs = row.attrs as { format: string; html: string; summary?: string; origin?: string };
    expect(attrs.format).toBe('html');
    expect(attrs.html).toBe(HTML_V1);
    expect(attrs.summary).toBe('可点击的周期表');
    expect(attrs.origin).toBe('copilot_author_artifact');
    const generatedBy = row.generated_by as { by: string; task_kind: string; task_run_id: string };
    expect(generatedBy).toMatchObject({
      by: 'ai',
      task_kind: 'author_artifact',
      task_run_id: 'tr_author_artifact',
    });

    // Locks the §1 enum extensions: the row passes the read-side select schema
    // (intent_source / tool_kind / type all widened additively).
    expect(() => Artifact.parse(row)).not.toThrow();
  });

  it('rejects bad input: missing title, html over cap, unknown type (no row written)', async () => {
    const db = testDb();

    await expect(authorInteractive({ title: '' })).rejects.toThrow();
    await expect(
      authorInteractive({ html: 'x'.repeat(INTERACTIVE_HTML_MAX_CHARS + 1) }),
    ).rejects.toThrow();
    await expect(
      authorArtifactTool.execute(ctx(), {
        // Future authorable types widen the enum; today only 'interactive'.
        type: 'note_atomic' as 'interactive',
        title: 't',
        html: HTML_V1,
      }),
    ).rejects.toThrow();

    const rows = await db.select({ id: artifact.id }).from(artifact);
    expect(rows).toEqual([]);
  });

  it('update happy path: v0→v1 bump, history entry, attrs merge preserves summary/origin', async () => {
    const db = testDb();
    const created = await authorInteractive();
    const [before] = await db.select().from(artifact).where(eq(artifact.id, created.artifact_id));

    const out = await updateArtifactTool.execute(ctx(), {
      artifact_id: created.artifact_id,
      html: HTML_V2,
      change_summary: '加入第七周期元素',
    });
    expect(out).toEqual({ artifact_id: created.artifact_id, previous_version: 0, version: 1 });

    const [row] = await db.select().from(artifact).where(eq(artifact.id, created.artifact_id));
    expect(row.version).toBe(1);
    expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());

    // Attrs merge: html replaced, summary/origin preserved.
    const attrs = row.attrs as { format: string; html: string; summary?: string; origin?: string };
    expect(attrs.html).toBe(HTML_V2);
    expect(attrs.format).toBe('html');
    expect(attrs.summary).toBe('可点击的周期表');
    expect(attrs.origin).toBe('copilot_author_artifact');

    // History entry follows the body-blocks-edit bookkeeping shape. NOTE: no
    // event_id — the mirror event is minted by the bridge AFTER execute returns
    // (correlation goes via tool_call_log.mirrored_event_id).
    expect(row.history).toHaveLength(1);
    expect(row.history[0]).toMatchObject({
      version: 1,
      summary_md: '加入第七周期元素',
      action: 'interactive_html_update',
      previous_artifact_version: 0,
      next_artifact_version: 1,
      by: { by: 'ai', task_kind: 'update_artifact', task_run_id: 'tr_author_artifact' },
    });

    // Second update: v1→v2, history appends, default summary_md when absent.
    const out2 = await updateArtifactTool.execute(ctx(), {
      artifact_id: created.artifact_id,
      html: HTML_V1,
    });
    expect(out2).toEqual({ artifact_id: created.artifact_id, previous_version: 1, version: 2 });
    const [row2] = await db.select().from(artifact).where(eq(artifact.id, created.artifact_id));
    expect(row2.history).toHaveLength(2);
    expect(row2.history[1]).toMatchObject({ version: 2, summary_md: 'Updated interactive HTML' });
    expect(() => Artifact.parse(row2)).not.toThrow();
  });

  it('update rejections: nonexistent id, archived row, non-interactive target', async () => {
    const db = testDb();

    await expect(
      updateArtifactTool.execute(ctx(), { artifact_id: 'art_gone', html: HTML_V2 }),
    ).rejects.toThrow(/does not exist/);

    const created = await authorInteractive();
    await db
      .update(artifact)
      .set({ archived_at: new Date() })
      .where(eq(artifact.id, created.artifact_id));
    await expect(
      updateArtifactTool.execute(ctx(), { artifact_id: created.artifact_id, html: HTML_V2 }),
    ).rejects.toThrow(/archived/);

    // A non-interactive artifact (here a minimal tool_quiz-shaped row) must be
    // refused — update_artifact is the interactive-only seam.
    const now = new Date();
    await db.insert(artifact).values({
      id: 'art_quiz',
      type: 'tool_quiz',
      title: '练习卷',
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'quiz_gen',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: null,
      attrs: {},
      tool_kind: 'quiz_gen',
      tool_state: { question_ids: ['q1'] } as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await expect(
      updateArtifactTool.execute(ctx(), { artifact_id: 'art_quiz', html: HTML_V2 }),
    ).rejects.toThrow(/type 'tool_quiz'/);
  });

  it('invariant: an interactive row never matches the practice gates (reference, not practice)', async () => {
    const db = testDb();
    const created = await authorInteractive();

    // The practice list gate (practice-read.ts) double-filters on
    // type='tool_quiz' + the paper intent_source whitelist; /api/practice
    // start rejects non-tool_quiz. The interactive row matches neither leg.
    const matched = await db
      .select({ id: artifact.id })
      .from(artifact)
      .where(
        and(
          eq(artifact.type, 'tool_quiz'),
          inArray(artifact.intent_source, [
            'review_plan',
            'quiz_gen',
            'embedded_check',
            'ingestion_paper',
          ]),
        ),
      );
    expect(matched.map((r) => r.id)).not.toContain(created.artifact_id);
    expect(matched).toEqual([]);
  });
});

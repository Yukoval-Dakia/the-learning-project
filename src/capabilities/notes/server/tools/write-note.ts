// YUK-1769 — write_note: the companion's direct Markdown note write.
//
// Background: the copilot surface previously offered ONLY the now-deleted
// interactive-HTML authoring pair (ADR-0033) as its save-a-note path. A learner
// asking 「存成笔记」 forced the model to author a full HTML page, which the
// learning-content gate then rejected repeatedly. This tool is the plain
// Markdown write path the coordinator ruling asked for (2026-11-03):
//
//   - mode='create'   → INSERT a note_long artifact carrying the Markdown body
//                       (atomic double-write: artifact_create event in the same
//                       tx).
//   - mode='append'   → merge one new block onto an existing note through
//                       editArtifactBodyBlocks (the canonical versioned write:
//                       optimistic version check + history + fold-source
//                       body_blocks_edit event + backlink sync).
//   - mode='generate' → hand off a complete/systematic note to the durable
//                       note_generate task: the pending artifact IS the durable
//                       intent (the recovery floor re-dispatches from it), then
//                       post-commit dispatchNoteGeneration.
//                       The output reports `generation_queued`, NOT written —
//                       the worker fills body_blocks asynchronously.
//
// No pre-write gate (no AI review, no preview): single-user, non-destructive
// create/append — the ADR-0033 D6 effect='write' stance.
//
// Error contract: domain-check failures throw z.ZodError with custom issues
// naming the offending field (query-events.ts precedent) so the model can
// repair and resubmit; the shared bridge serializes the issue list verbatim.
// Structural validation (missing title/markdown/note_id per mode) is a
// superRefine on the schema — the model gets `code/path/message` for the exact
// field instead of a prose error.
//
// phase-deferred (write_quiz same stance): no per-run
// idempotency guard — a duplicate create is non-destructive; add a guard only
// if real usage shows double-writes.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import { artifact } from '@/db/schema';
import { artifactRowToCreateSnapshot, emitArtifactCreateEvent } from '@/kernel/artifacts';
import { downgradeUnboundChartFences } from '@/kernel/blocks/markdown-chart-fence';
import { writeNoteGenerationIntent } from '@/kernel/records/note-handoff-protocol';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { syncBlockRefsForArtifact } from '../block-refs';
import { editArtifactBodyBlocks } from '../body-blocks-edit';
import { NOTE_ARTIFACT_TYPES } from '../note-artifact-types';
import { dispatchNoteGeneration } from '../note-handoff';

// Generous ceiling: a full review note fits far below this; the cap exists only
// to bound pathological tool inputs.
export const WRITE_NOTE_MARKDOWN_MAX_CHARS = 100_000;

const NOTE_BLOCK_SOURCE_TIER = 'llm_only';

// One Markdown chunk ↔ one semanticBlock: the raw Markdown lives in
// attrs.source_markdown (the reader's blockText source) and in a single
// paragraph child (the editor's PM mirror). The block
// intentionally carries NO semantic_kind — a free-form prose block renders as
// the plain nrb block, not one of the five section kinds. This write path has no
// tool-result binding step, so a recorded-data chart fence is downgraded here.
function markdownBlock(blockId: string, markdown: string): Record<string, unknown> {
  const source = downgradeUnboundChartFences(markdown);
  return {
    type: 'semanticBlock',
    attrs: {
      id: blockId,
      source_tier: NOTE_BLOCK_SOURCE_TIER,
      user_verified: false,
      version: 1,
      source_markdown: source,
    },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: source }] }],
  };
}

function fieldIssue(path: string, message: string) {
  return { code: 'custom' as const, path: [path], message };
}

const WriteNoteInputSchema = z
  .object({
    // create = write a NEW note with the given Markdown body now.
    // append = add the Markdown body as a new block on an EXISTING note.
    // generate = queue the durable note_generate task to author a complete,
    //   systematic note (returns generation_queued — content is NOT written yet).
    mode: z
      .enum(['create', 'append', 'generate'])
      .describe(
        'create writes a NEW note now (returns written + artifact_id); append adds markdown as a new block on an existing note_id and bumps its version; generate hands off to the durable note_generate task for a complete systematic note — returns generation_queued, so say queued, not written.',
      ),
    // Required for create + generate: the note's title.
    title: z.string().min(1).max(120).optional().describe('Required for create/generate.'),
    // Required for append: the artifact id of the existing note (art_… id
    // returned by an earlier write_note call or the notes API).
    note_id: z
      .string()
      .min(1)
      .optional()
      .describe('Existing note artifact id (art_…) — required for append.'),
    // Required for create + append: the Markdown content to write.
    markdown: z
      .string()
      .min(1)
      .max(WRITE_NOTE_MARKDOWN_MAX_CHARS)
      .optional()
      .describe('Markdown content — required for create/append.'),
    // Optional one-line intent for mode=generate (steers the note_generate
    // task, e.g. 「给期中复习的系统笔记」). Ignored for create/append.
    intent: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('One-line intent steering note_generate (generate only).'),
    // Optional knowledge-node labels for discovery. No existence check — a
    // dangling id degrades discovery, it breaks nothing (ADR-0033 D6).
    knowledge_ids: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe('Knowledge-node labels for discovery; no existence check.'),
  })
  .superRefine((input, ctx) => {
    if ((input.mode === 'create' || input.mode === 'generate') && !input.title?.trim()) {
      ctx.addIssue(fieldIssue('title', `title is required when mode is '${input.mode}'`));
    }
    if ((input.mode === 'create' || input.mode === 'append') && !input.markdown?.trim()) {
      ctx.addIssue(fieldIssue('markdown', `markdown is required when mode is '${input.mode}'`));
    }
    if (input.mode === 'append' && !input.note_id) {
      ctx.addIssue(fieldIssue('note_id', "note_id is required when mode is 'append'"));
    }
  });
type WriteNoteInput = z.input<typeof WriteNoteInputSchema>;

const WriteNoteOutputSchema = z.object({
  // 'written' = the Markdown is persisted; 'generation_queued' = the
  // note_generate task is durably queued but has NOT produced content yet.
  status: z.enum(['written', 'generation_queued']),
  artifact_id: z.string(),
  title: z.string(),
  version: z.number().int().nonnegative(),
  // True only when the post-commit pg-boss dispatch was confirmed; false means
  // the durable intent exists and the every-minute hub_sync_recovery floor will
  // retry the dispatch — still queued, just not confirmed this turn.
  dispatch_confirmed: z.boolean().optional(),
});
type WriteNoteOutput = z.infer<typeof WriteNoteOutputSchema>;

function generatedByRef(ctx: ToolContext): Record<string, unknown> {
  return { by: 'ai', task_kind: 'write_note', task_run_id: ctx.taskRunId };
}

async function createNoteArtifact(
  ctx: ToolContext,
  input: WriteNoteInput,
  bodyBlocks: ArtifactBodyBlocksT | null,
  generationStatus: 'ready' | 'pending',
): Promise<void> {
  const now = new Date();
  const knowledgeIds = input.knowledge_ids ?? [];
  await ctx.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(artifact)
      .values({
        id: input.note_id as string,
        type: 'note_long',
        title: input.title as string,
        parent_artifact_id: null,
        knowledge_ids: knowledgeIds,
        intent_source: 'write_note',
        source: 'ai_generated',
        source_ref: null,
        body_blocks: bodyBlocks as never,
        attrs: {
          origin: 'copilot_write_note',
          ...(input.intent ? { one_line_intent: input.intent } : {}),
        } as never,
        tool_kind: 'write_note',
        generation_status: generationStatus,
        generated_by: generatedByRef(ctx) as never,
        history: [],
        created_at: now,
        updated_at: now,
        version: 0,
      })
      .returning();
    await emitArtifactCreateEvent(tx, {
      row: artifactRowToCreateSnapshot(inserted),
      actorKind: ctx.callerActor.kind === 'cron' ? 'system' : ctx.callerActor.kind,
      actorRef: ctx.callerActor.ref,
      causedByEventId: ctx.causedByEventId ?? null,
      taskRunId: ctx.taskRunId,
      createdAt: now,
    });
    // Same committed-tx backlink index as the canonical edit path (a generated
    // block tree can carry crossLinkBlock children on later appends).
    if (bodyBlocks) await syncBlockRefsForArtifact(tx, input.note_id as string, bodyBlocks);
    // generation='pending' rides the durable handoff: the intent lands in the
    // same tx so the post-commit dispatch can send immediately instead of
    // waiting for the every-minute recovery floor (learning-intent-note-birth).
    if (generationStatus === 'pending') {
      await writeNoteGenerationIntent(tx, input.note_id as string);
    }
  });
}

async function executeWriteNote(
  ctx: ToolContext,
  rawInput: WriteNoteInput,
): Promise<WriteNoteOutput> {
  const input = WriteNoteInputSchema.parse(rawInput);

  if (input.mode === 'append') {
    const rows = await ctx.db
      .select({
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        body_blocks: artifact.body_blocks,
        version: artifact.version,
        generation_status: artifact.generation_status,
        archived_at: artifact.archived_at,
      })
      .from(artifact)
      .where(eq(artifact.id, input.note_id as string))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new z.ZodError([fieldIssue('note_id', `note ${input.note_id} does not exist`)]);
    }
    if (!(NOTE_ARTIFACT_TYPES as readonly string[]).includes(row.type)) {
      throw new z.ZodError([
        fieldIssue(
          'note_id',
          `note ${input.note_id} has type '${row.type}' — only note artifacts can be appended`,
        ),
      ]);
    }
    if (row.archived_at) {
      throw new z.ZodError([fieldIssue('note_id', `note ${input.note_id} is archived`)]);
    }
    // A pending note's body is about to be overwritten by note_generate (its
    // UPDATE CASes on generation_status='pending'); a failed one may be CAS-
    // reopened by a pg-boss redelivery. Appending now would silently lose the
    // block — tell the model to retry once generation settles.
    if (row.generation_status !== 'ready') {
      throw new z.ZodError([
        fieldIssue(
          'note_id',
          `note ${input.note_id} generation_status is '${row.generation_status}', not 'ready' — append only after generation completes`,
        ),
      ]);
    }

    const merged: ArtifactBodyBlocksT = {
      type: 'doc',
      content: [
        ...((row.body_blocks?.content ?? []) as Record<string, unknown>[]),
        markdownBlock(`wnb_${createId()}`, input.markdown as string),
      ],
    };
    const result = await editArtifactBodyBlocks({
      db: ctx.db,
      artifactId: input.note_id as string,
      expectedArtifactVersion: row.version,
      bodyBlocks: merged,
      actorKind: 'agent',
      actorRef: 'write_note',
      historyBy: { by: 'ai', task_kind: 'write_note', task_run_id: ctx.taskRunId },
      historySummaryMd: 'Appended Markdown block (copilot write_note)',
    });
    return {
      status: 'written',
      artifact_id: input.note_id as string,
      title: row.title,
      version: result.artifact_version,
    };
  }

  const artifactId = `art_${createId()}`;
  if (input.mode === 'generate') {
    await createNoteArtifact(ctx, { ...input, note_id: artifactId }, null, 'pending');
    // Post-commit dispatcher: the durable intent + a confirmed send. A `false`
    // here only means THIS dispatch attempt didn't land — the every-minute
    // hub_sync_recovery floor re-dispatches from the persisted intent.
    const dispatchConfirmed = await dispatchNoteGeneration(ctx.db, artifactId).catch(() => false);
    return {
      status: 'generation_queued',
      artifact_id: artifactId,
      title: input.title as string,
      version: 0,
      dispatch_confirmed: dispatchConfirmed,
    };
  }

  const bodyBlocks: ArtifactBodyBlocksT = {
    type: 'doc',
    content: [markdownBlock(`wnb_${createId()}`, input.markdown as string)],
  };
  await createNoteArtifact(ctx, { ...input, note_id: artifactId }, bodyBlocks, 'ready');
  return {
    status: 'written',
    artifact_id: artifactId,
    title: input.title as string,
    version: 0,
  };
}

export const writeNoteTool: DomainTool<WriteNoteInput, WriteNoteOutput> = {
  name: 'write_note',
  description:
    'Write a Markdown note for the learner. Errors come back as typed field issues — fix the named field and resubmit.',
  effect: 'write',
  inputSchema: WriteNoteInputSchema,
  outputSchema: WriteNoteOutputSchema,
  costClass: 'local',
  // Copilot-initiated write — leave an event trail (evidence-first).
  mirrorEvent: 'when_causal',
  execute: executeWriteNote,
  summarize(input, output) {
    return `write_note · ${output.status} · ${output.artifact_id} · ${input.title?.slice(0, 40) ?? ''}`;
  },
};

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
//   - mode='patch'    → replace text inside an existing note by original-text
//                       anchors (note-markdown-patch.ts): every anchor must
//                       match exactly once, all edits commit or none, and the
//                       caller's base_version is the CAS baseline. Same commit
//                       path as append; user-verified blocks are refused.
//   - mode='generate' → hand off a complete/systematic note to the durable
//                       note_generate task: the pending artifact IS the durable
//                       intent (the recovery floor re-dispatches from it), then
//                       post-commit dispatchNoteGeneration.
//                       The output reports `generation_queued`, NOT written —
//                       the worker fills body_blocks asynchronously.
//
// No pre-write gate (no AI review, no preview): single-user, non-destructive
// create/append/patch — the ADR-0033 D6 effect='write' stance.
//
// Error contract: domain-check failures throw z.ZodError with custom issues
// naming the offending field (query-events.ts precedent) so the model can
// repair and resubmit; the shared bridge serializes the issue list verbatim.
// Structural validation (missing title/markdown/note_id/base_version/edits per
// mode) is a superRefine on the schema — the model gets `code/path/message` for
// the exact field instead of a prose error.
//
// phase-deferred (write_quiz same stance): no per-run
// idempotency guard — a duplicate create is non-destructive; add a guard only
// if real usage shows double-writes.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { isVerifiedBlock } from '@/core/blocks/is-verified-block';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import { artifact } from '@/db/schema';
import { artifactRowToCreateSnapshot, emitArtifactCreateEvent } from '@/kernel/artifacts';
import { ApiError } from '@/kernel/http';
import { writeNoteGenerationIntent } from '@/kernel/records/note-handoff-protocol';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { syncBlockRefsForArtifact } from '../block-refs';
import { editArtifactBodyBlocks } from '../body-blocks-edit';
import { NOTE_ARTIFACT_TYPES } from '../note-artifact-types';
import { dispatchNoteGeneration } from '../note-handoff';
import {
  type MarkdownAnchorEdit,
  type NoteMarkdownPatchFailure,
  applyMarkdownAnchorEdits,
} from '../note-markdown-patch';
import { patchTouchesVerifiedBlock } from '../note-refine-policy';

// Generous ceiling: a full review note fits far below this; the cap exists only
// to bound pathological tool inputs.
export const WRITE_NOTE_MARKDOWN_MAX_CHARS = 100_000;

const NOTE_BLOCK_SOURCE_TIER = 'llm_only';

// One call patches at most this many spans; the cap bounds tool input, not a gate.
export const WRITE_NOTE_MAX_PATCH_EDITS = 20;
// Anchors are copied note text, not authored content — a few hundred characters
// is far above any single block passage and bounds error feedback.
export const WRITE_NOTE_ANCHOR_MAX_CHARS = 2_000;

// One Markdown chunk ↔ one semanticBlock, mirroring noteSectionsToBodyBlocks:
// the raw Markdown lives in attrs.source_markdown (the reader's blockText
// source) and in a single paragraph child (the editor's PM mirror). The block
// intentionally carries NO semantic_kind — a free-form prose block renders as
// the plain nrb block, not one of the five section kinds.
function markdownBlock(blockId: string, markdown: string): Record<string, unknown> {
  return {
    type: 'semanticBlock',
    attrs: {
      id: blockId,
      source_tier: NOTE_BLOCK_SOURCE_TIER,
      user_verified: false,
      version: 1,
      source_markdown: markdown,
    },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }],
  };
}

function fieldIssue(path: string, message: string) {
  return { code: 'custom' as const, path: [path], message };
}

const WriteNoteEdit = z.object({
  // Exact substring of the note text the model wants to change; must match
  // exactly once across the whole note (0 or 2+ matches reject the call).
  anchor: z.string().min(1).max(WRITE_NOTE_ANCHOR_MAX_CHARS),
  // Replacement text inserted in place of the anchor; '' deletes the anchor.
  replacement: z.string().max(WRITE_NOTE_MARKDOWN_MAX_CHARS),
});

const WriteNoteInputSchema = z
  .object({
    // create = write a NEW note with the given Markdown body now.
    // append = add the Markdown body as a new block on an EXISTING note.
    // patch = edit the text of an EXISTING note in place (anchor + replacement).
    // generate = queue the durable note_generate task to author a complete,
    //   systematic note (returns generation_queued — content is NOT written yet).
    mode: z.enum(['create', 'append', 'patch', 'generate']),
    // Required for create + generate: the note's title.
    title: z.string().min(1).max(120).optional(),
    // Required for append + patch: the artifact id of the existing note (an art_…
    // id returned by an earlier write_note call or the notes API).
    note_id: z.string().min(1).optional(),
    // Required for create + append: the Markdown content to write.
    markdown: z.string().min(1).max(WRITE_NOTE_MARKDOWN_MAX_CHARS).optional(),
    // Required for patch: the note version the model last saw. A stale baseline
    // rejects the whole call instead of overwriting a newer body.
    base_version: z.number().int().nonnegative().optional(),
    // Required for patch: ordered anchor→replacement edits, atomic as a group.
    edits: z.array(WriteNoteEdit).min(1).max(WRITE_NOTE_MAX_PATCH_EDITS).optional(),
    // Optional one-line intent for mode=generate (steers the note_generate
    // task, e.g. 「给期中复习的系统笔记」). Ignored for create/append/patch.
    intent: z.string().min(1).max(500).optional(),
    // Optional knowledge-node labels for discovery. No existence check — a
    // dangling id degrades discovery, it breaks nothing (ADR-0033 D6).
    knowledge_ids: z.array(z.string().min(1)).max(20).optional(),
  })
  .superRefine((input, ctx) => {
    if ((input.mode === 'create' || input.mode === 'generate') && !input.title?.trim()) {
      ctx.addIssue(fieldIssue('title', `title is required when mode is '${input.mode}'`));
    }
    if ((input.mode === 'create' || input.mode === 'append') && !input.markdown?.trim()) {
      ctx.addIssue(fieldIssue('markdown', `markdown is required when mode is '${input.mode}'`));
    }
    if ((input.mode === 'append' || input.mode === 'patch') && !input.note_id) {
      ctx.addIssue(fieldIssue('note_id', `note_id is required when mode is '${input.mode}'`));
    }
    if (input.mode === 'patch') {
      if (input.base_version === undefined) {
        ctx.addIssue(fieldIssue('base_version', "base_version is required when mode is 'patch'"));
      }
      if (!input.edits || input.edits.length === 0) {
        ctx.addIssue(fieldIssue('edits', "edits is required when mode is 'patch'"));
      }
      if (input.markdown !== undefined) {
        ctx.addIssue(
          fieldIssue('markdown', "markdown is not used by mode 'patch' — send edits instead"),
        );
      }
      if (input.title !== undefined) {
        ctx.addIssue(fieldIssue('title', "title is not used by mode 'patch' — patch keeps it"));
      }
      return;
    }
    if (input.edits !== undefined) {
      ctx.addIssue(fieldIssue('edits', "edits is only used by mode 'patch'"));
    }
    if (input.base_version !== undefined) {
      ctx.addIssue(fieldIssue('base_version', "base_version is only used by mode 'patch'"));
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

interface WritableNoteRow {
  id: string;
  type: string;
  title: string;
  body_blocks: unknown;
  version: number;
  generation_status: string;
  archived_at: Date | null;
}

// Same preconditions for every write onto an existing note (append + patch).
async function loadWritableNote(
  ctx: ToolContext,
  noteId: string,
  verb: 'append' | 'patch',
): Promise<WritableNoteRow> {
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
    .where(eq(artifact.id, noteId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new z.ZodError([fieldIssue('note_id', `note ${noteId} does not exist`)]);
  }
  if (!(NOTE_ARTIFACT_TYPES as readonly string[]).includes(row.type)) {
    throw new z.ZodError([
      fieldIssue(
        'note_id',
        `note ${noteId} has type '${row.type}' — only note artifacts can be edited with mode='${verb}'`,
      ),
    ]);
  }
  if (row.archived_at) {
    throw new z.ZodError([fieldIssue('note_id', `note ${noteId} is archived`)]);
  }
  // A pending note's body is about to be overwritten by note_generate (its
  // UPDATE CASes on generation_status='pending'); a failed one may be CAS-
  // reopened by a pg-boss redelivery. Editing now would silently lose the
  // change — tell the model to retry once generation settles.
  if (row.generation_status !== 'ready') {
    throw new z.ZodError([
      fieldIssue(
        'note_id',
        `note ${noteId} generation_status is '${row.generation_status}', not 'ready' — ${verb} only after generation completes`,
      ),
    ]);
  }
  return row;
}

function shortAnchor(anchor: string): string {
  return anchor.length > 80 ? `${anchor.slice(0, 77)}...` : anchor;
}

function staleVersionIssue(noteId: string, baseVersion: number, currentVersion: number) {
  return new z.ZodError([
    fieldIssue(
      'base_version',
      `note ${noteId} is at version ${currentVersion}, not ${baseVersion} — re-read the note and retry with base_version=${currentVersion}`,
    ),
  ]);
}

function patchFailureIssue(failure: NoteMarkdownPatchFailure) {
  switch (failure.code) {
    case 'invalid_body_blocks':
      return fieldIssue('edits', `the note body cannot be patched: ${failure.message}`);
    case 'anchor_not_found':
      return fieldIssue(
        'edits',
        `anchor "${shortAnchor(failure.anchor)}" was not found in any of the ${failure.scanned_blocks} note blocks — copy the anchor exactly from the note text`,
      );
    case 'anchor_ambiguous': {
      const total = failure.matches.reduce((sum, match) => sum + match.count, 0);
      const where = failure.matches
        .map((match) => `${match.block_id ?? '(no id)'} ×${match.count}`)
        .join(', ');
      return fieldIssue(
        'edits',
        `anchor "${shortAnchor(failure.anchor)}" matches ${total} times; it must match exactly once — matches: ${where}`,
      );
    }
    case 'anchor_spans_runs':
      return fieldIssue(
        'edits',
        `anchor "${shortAnchor(failure.anchor)}" crosses a formatting or line boundary in block ${failure.block_id ?? '(no id)'} — use a shorter anchor inside one text run`,
      );
    case 'anchor_mirror_mismatch':
      return fieldIssue(
        'edits',
        failure.count === 0
          ? `anchor "${shortAnchor(failure.anchor)}" crosses formatting inside block ${failure.block_id ?? '(no id)'} — use a shorter anchor without markdown marks`
          : `anchor "${shortAnchor(failure.anchor)}" matches block ${failure.block_id ?? '(no id)'} ${failure.count} times in its Markdown body; it must match exactly once`,
      );
  }
}

async function executePatch(ctx: ToolContext, input: WriteNoteInput): Promise<WriteNoteOutput> {
  const noteId = input.note_id as string;
  const baseVersion = input.base_version as number;
  const row = await loadWritableNote(ctx, noteId, 'patch');
  if (row.version !== baseVersion) {
    throw staleVersionIssue(noteId, baseVersion, row.version);
  }

  const patched = applyMarkdownAnchorEdits(row.body_blocks, input.edits as MarkdownAnchorEdit[]);
  if (!patched.ok) throw new z.ZodError([patchFailureIssue(patched.failure)]);

  // Same verified-block judgement as the note-refine mutator gate: a patch
  // rewrites the matched block's text, i.e. replace_block semantics.
  const verified = patched.touched.filter(({ block_id, block }) =>
    block_id === null
      ? isVerifiedBlock(block)
      : patchTouchesVerifiedBlock(patched.body_blocks, {
          ops: [{ kind: 'replace_block', target_block_id: block_id, block }],
        }),
  );
  if (verified.length > 0) {
    throw new z.ZodError([
      fieldIssue(
        'edits',
        `block(s) ${verified.map(({ block_id }) => block_id ?? '(no id)').join(', ')} are user-verified — the learner edited them, so ask before changing them or use mode='append'`,
      ),
    ]);
  }

  let result: Awaited<ReturnType<typeof editArtifactBodyBlocks>>;
  try {
    result = await editArtifactBodyBlocks({
      db: ctx.db,
      artifactId: noteId,
      expectedArtifactVersion: row.version,
      bodyBlocks: patched.body_blocks,
      actorKind: 'agent',
      actorRef: 'write_note',
      historyBy: { by: 'ai', task_kind: 'write_note', task_run_id: ctx.taskRunId },
      historySummaryMd: 'Patched Markdown text (copilot write_note)',
    });
  } catch (error) {
    // The commit re-checks the version under its row lock; report the new
    // baseline the same way a pre-write mismatch does.
    if (error instanceof ApiError && error.status === 409) {
      const current = await ctx.db
        .select({ version: artifact.version })
        .from(artifact)
        .where(eq(artifact.id, noteId))
        .limit(1);
      if (current[0] && current[0].version !== baseVersion) {
        throw staleVersionIssue(noteId, baseVersion, current[0].version);
      }
    }
    throw error;
  }

  return {
    status: 'written',
    artifact_id: noteId,
    title: row.title,
    version: result.artifact_version,
  };
}

async function executeWriteNote(
  ctx: ToolContext,
  rawInput: WriteNoteInput,
): Promise<WriteNoteOutput> {
  const input = WriteNoteInputSchema.parse(rawInput);

  if (input.mode === 'patch') {
    return executePatch(ctx, input);
  }

  if (input.mode === 'append') {
    const row = await loadWritableNote(ctx, input.note_id as string, 'append');
    const merged: ArtifactBodyBlocksT = {
      type: 'doc',
      content: [
        ...((row.body_blocks as ArtifactBodyBlocksT | null)?.content ?? []),
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
    'Write a Markdown note for the learner. mode=create saves a NEW note with the given title and markdown and returns status=written with its artifact_id. mode=append adds the markdown as a new block on an existing note_id (an art_… id returned earlier or from the notes API) and bumps its version. mode=patch edits an existing note in place: pass note_id, base_version (the version from the last write_note result) and edits[{anchor,replacement}]; each anchor is copied from the note text and must match exactly once in the whole note — 0 or several matches reject the call with the matching block ids, a stale base_version or a user-verified target rejects it, and all edits apply together or not at all. mode=generate hands off to the durable note_generate task when the learner asks for a complete, systematic note — returns status=generation_queued and the note content is produced asynchronously, so say it is queued, not written. Errors come back as typed field issues — fix the named field and resubmit.',
  effect: 'write',
  inputSchema: WriteNoteInputSchema,
  outputSchema: WriteNoteOutputSchema,
  costClass: 'local',
  // Copilot-initiated write — leave an event trail (evidence-first).
  mirrorEvent: 'when_causal',
  execute: executeWriteNote,
  summarize(input, output) {
    const label = input.title?.slice(0, 40) || input.mode;
    return `write_note · ${output.status} · ${output.artifact_id} · ${label}`;
  },
};

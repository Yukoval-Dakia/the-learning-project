// Learner precise edit = history the person wrote. updated_at also moves on
// generation, refine and hub sync. mark_wrong_count counts correction events;
// a later restore does not erase them. Pending review is verification_summary,
// which generation still writes. check_note is the live recheck.

import { and, count, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { ArtifactBodyBlocks, ArtifactVerificationSummary } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, event } from '@/db/schema';
import { getArtifactCorrectionStates } from '@/kernel/read-models/artifact-corrections';
import { noteBlockSource } from '@/kernel/read-models/note-block-source';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';

const NOTE_TYPES = ['note_atomic', 'note_long', 'note_hub'] as const;
const QUERY_LIMIT = 5;
const BODY_MAX_CHARS = 8_000;
const SKIP_TYPES = new Set([
  'artifactRefBlock',
  'questionRefBlock',
  'crossLinkBlock',
  'image',
  'horizontalRule',
]);

const ReadNoteInputSchema = z
  .object({
    note_id: z.string().trim().min(1).max(80).optional().describe('笔记 id'),
    query: z.string().trim().min(1).max(80).optional().describe('标题关键词'),
  })
  .superRefine((value, ctx) => {
    if ((value.note_id !== undefined) === (value.query !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'note_id 或 query 二选一',
        path: [value.note_id !== undefined ? 'query' : 'note_id'],
      });
    }
  });
type ReadNoteInput = z.infer<typeof ReadNoteInputSchema>;

const NoteReadSchema = z.object({
  note_id: z.string(),
  title: z.string().nullable(),
  note_type: z.string(),
  generation_status: z.string(),
  body_md: z.string().nullable(),
  body_truncated: z.boolean(),
  hidden: z.enum(['retracted', 'superseded']).nullable(),
  mark_wrong_count: z.number().int().nonnegative(),
  last_precise_edit_at: z.string().nullable(),
  pending_review_count: z.number().int().nonnegative().nullable(),
  refine_apply_count: z.number().int().nonnegative(),
});
type NoteRead = z.infer<typeof NoteReadSchema>;

const ReadNoteOutputSchema = z.object({
  notes: z.array(NoteReadSchema),
  has_more: z.boolean(),
});
type ReadNoteOutput = z.infer<typeof ReadNoteOutputSchema>;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function asCount(value: unknown): number {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

function lastPreciseEditAt(history: unknown): string | null {
  if (!Array.isArray(history)) return null;
  let latest: number | null = null;
  for (const entry of history) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const by =
      row.by !== null && typeof row.by === 'object' ? (row.by as { by?: unknown }).by : undefined;
    const learnerEdit =
      by === 'user' && (row.action === 'block_edit' || row.action === 'body_blocks_edit');
    if (!learnerEdit) continue;
    const at =
      row.at instanceof Date ? row.at : typeof row.at === 'string' ? new Date(row.at) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    const ms = at.getTime();
    if (latest === null || ms > latest) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function pendingReviewCount(summary: unknown): number | null {
  if (summary == null) return 0;
  const parsed = ArtifactVerificationSummary.safeParse(summary);
  if (!parsed.success) return null;
  if ('kind' in parsed.data) return parsed.data.issues.length;
  return parsed.data.verdict === 'needs_review' ? parsed.data.issues.length : 0;
}

function blockAttrs(node: Record<string, unknown>): Record<string, unknown> {
  return node.attrs !== null && typeof node.attrs === 'object' && !Array.isArray(node.attrs)
    ? (node.attrs as Record<string, unknown>)
    : {};
}

function descendantHidden(node: Record<string, unknown>, hidden: ReadonlySet<string>): boolean {
  const content = Array.isArray(node.content) ? node.content : [];
  for (const child of content) {
    if (child === null || typeof child !== 'object') continue;
    const record = child as Record<string, unknown>;
    const id = blockAttrs(record).id;
    if (typeof id === 'string' && hidden.has(id)) return true;
    if (descendantHidden(record, hidden)) return true;
  }
  return false;
}

function withoutHidden(
  node: Record<string, unknown>,
  hidden: ReadonlySet<string>,
): Record<string, unknown> | null {
  const id = blockAttrs(node).id;
  if (typeof id === 'string' && hidden.has(id)) return null;
  if (!Array.isArray(node.content)) return node;
  const content = [];
  for (const child of node.content) {
    if (child === null || typeof child !== 'object') continue;
    const kept = withoutHidden(child as Record<string, unknown>, hidden);
    if (kept) content.push(kept);
  }
  return { ...node, content };
}

// Same projection that built source_markdown. Hidden nodes are already gone,
// so a retracted child's text cannot come back through the parent mirror.
function projectNode(node: Record<string, unknown>): string {
  try {
    return noteBlockSource(node);
  } catch {
    const content = Array.isArray(node.content) ? node.content : [];
    const parts: string[] = [];
    for (const child of content) {
      if (child === null || typeof child !== 'object') continue;
      const text = projectNode(child as Record<string, unknown>).trim();
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }
}

function blockMarkdown(node: Record<string, unknown>, hidden: ReadonlySet<string>): string {
  const attrs = blockAttrs(node);
  if (typeof attrs.id === 'string' && hidden.has(attrs.id)) return '';
  const type = typeof node.type === 'string' ? node.type : '';
  if (SKIP_TYPES.has(type)) return '';
  if (
    type === 'semanticBlock' &&
    typeof attrs.source_markdown === 'string' &&
    !descendantHidden(node, hidden)
  ) {
    return attrs.source_markdown.trim();
  }
  const filtered = withoutHidden(node, hidden);
  return filtered ? projectNode(filtered).trim() : '';
}

function noteBodyMarkdown(
  body: unknown,
  hidden: ReadonlySet<string>,
): { body_md: string | null; body_truncated: boolean } {
  const parsed = ArtifactBodyBlocks.safeParse(body);
  if (!parsed.success) return { body_md: null, body_truncated: false };
  const parts: string[] = [];
  for (const node of parsed.data.content ?? []) {
    if (node === null || typeof node !== 'object') continue;
    const text = blockMarkdown(node as Record<string, unknown>, hidden).trim();
    if (text) parts.push(text);
  }
  if (parts.length === 0) return { body_md: null, body_truncated: false };
  const md = parts.join('\n\n');
  if (md.length <= BODY_MAX_CHARS) return { body_md: md, body_truncated: false };
  return { body_md: md.slice(0, BODY_MAX_CHARS), body_truncated: true };
}

async function countsBySubject(
  db: Db,
  ids: string[],
  action: string,
  kindSql?: ReturnType<typeof sql>,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ subject_id: event.subject_id, n: count() })
    .from(event)
    .where(
      and(
        eq(event.action, action),
        eq(event.subject_kind, 'artifact'),
        inArray(event.subject_id, ids),
        kindSql,
      ),
    )
    .groupBy(event.subject_id);
  return new Map(rows.map((row) => [row.subject_id, asCount(row.n)]));
}

async function executeReadNote(ctx: ToolContext, rawInput: ReadNoteInput): Promise<ReadNoteOutput> {
  const input = ReadNoteInputSchema.parse(rawInput);
  const filters = [
    isNull(artifact.archived_at),
    inArray(artifact.type, [...NOTE_TYPES]),
    input.note_id
      ? eq(artifact.id, input.note_id)
      : ilike(artifact.title, `%${escapeLike(input.query ?? '')}%`),
  ];
  const limit = input.note_id ? 1 : QUERY_LIMIT + 1;
  const loaded = await ctx.db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      body_blocks: artifact.body_blocks,
      generation_status: artifact.generation_status,
      verification_summary: artifact.verification_summary,
      history: artifact.history,
    })
    .from(artifact)
    .where(and(...filters))
    .orderBy(desc(artifact.updated_at), desc(artifact.id))
    .limit(limit);
  const hasMore = !input.note_id && loaded.length > QUERY_LIMIT;
  const rows = hasMore ? loaded.slice(0, QUERY_LIMIT) : loaded;
  const ids = rows.map((row) => row.id);
  const [corrections, markWrong, refineApplies] = await Promise.all([
    getArtifactCorrectionStates(ctx.db, ids),
    countsBySubject(
      ctx.db,
      ids,
      'correct',
      sql`${event.payload}->>'correction_kind' = 'mark_wrong'`,
    ),
    // An undo reverses the body; the apply still happened, so it stays in the count.
    countsBySubject(ctx.db, ids, 'experimental:note_refine_apply'),
  ]);

  const notes: NoteRead[] = rows.map((row) => {
    const correction = corrections.get(row.id);
    const whole = correction?.whole.state;
    const hidden = whole === 'retracted' || whole === 'superseded' ? whole : null;
    const hiddenBlocks = new Set<string>();
    if (correction) {
      for (const [blockId, state] of correction.blocks) {
        if (state.state === 'retracted' || state.state === 'superseded') hiddenBlocks.add(blockId);
      }
    }
    const body = hidden
      ? { body_md: null, body_truncated: false }
      : noteBodyMarkdown(row.body_blocks, hiddenBlocks);
    return {
      note_id: row.id,
      title: hidden ? null : row.title,
      note_type: row.type,
      generation_status: row.generation_status,
      body_md: body.body_md,
      body_truncated: body.body_truncated,
      hidden,
      mark_wrong_count: markWrong.get(row.id) ?? 0,
      last_precise_edit_at: lastPreciseEditAt(row.history),
      pending_review_count: pendingReviewCount(row.verification_summary),
      refine_apply_count: refineApplies.get(row.id) ?? 0,
    };
  });

  return ReadNoteOutputSchema.parse({ notes, has_more: hasMore });
}

export const readNoteTool: DomainTool<ReadNoteInput, ReadNoteOutput> = {
  name: 'read_note',
  description: '读笔记正文和统计。note_id 与 query 二选一。',
  effect: 'read',
  inputSchema: ReadNoteInputSchema,
  outputSchema: ReadNoteOutputSchema,
  costClass: 'local',
  mirrorEvent: 'when_user_visible',
  execute: executeReadNote,
  summarize(_input, output) {
    return `read_note · ${output.notes.length}`;
  },
};

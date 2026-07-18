// YUK-293 — model-callable agent-note read/write pair.
//
// Agent notes are expiring AI-to-AI hints, never learner facts and never inbox
// proposals. The write tool therefore persists directly through writeAgentNote,
// while its bounded schema + default expiry prevent an unbounded hidden channel.

import { z } from 'zod';

import type { DomainTool, ToolContext } from '@/server/ai/tools/types';
import { ApiError } from '@/server/http/errors';
import { type AgentNoteTarget, readAgentNotes, writeAgentNote } from './notes';

const TARGETS = ['dreaming', 'maintenance', 'coach', 'research_meeting', 'copilot'] as const;
const DEFAULT_EXPIRY_DAYS = 30;
const MAX_NOTES = 20;
const MAX_REFS = 20;
const MAX_SUMMARY_CHARS = 2_000;

const AgentNoteTargetSchema = z.enum(TARGETS);
const AgentNoteRefSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  id: z.string().trim().min(1).max(160),
});

const WriteAgentNoteInputSchema = z.object({
  target_agents: z
    .array(AgentNoteTargetSchema)
    .min(1)
    .max(TARGETS.length)
    .refine((targets) => new Set(targets).size === targets.length, {
      message: 'target_agents must not contain duplicates',
    }),
  summary_md: z.string().trim().min(1).max(MAX_SUMMARY_CHARS),
  signal_kind: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9:_-]*$/, 'signal_kind must be a stable lowercase identifier'),
  refs: z.array(AgentNoteRefSchema).max(MAX_REFS).default([]),
  confidence: z.number().min(0).max(1).optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
});

const WriteAgentNoteOutputSchema = z.object({
  status: z.literal('written'),
  note_id: z.string(),
  expires_at: z.string().datetime({ offset: true }),
});

const ReadAgentNotesInputSchema = z.object({
  for_agent: AgentNoteTargetSchema,
  limit: z.number().int().min(1).max(MAX_NOTES).default(10),
});

const ReadAgentNotesOutputSchema = z.object({
  notes: z.array(
    z.object({
      id: z.string(),
      created_at: z.string().datetime({ offset: true }),
      target_agents: z.array(AgentNoteTargetSchema),
      source_task_kind: z.string(),
      source_task_run_id: z.string().optional(),
      refs: z.array(AgentNoteRefSchema),
      summary_md: z.string(),
      signal_kind: z.string(),
      confidence: z.number().optional(),
      expires_at: z.string().optional(),
      caused_by_event_id: z.string().optional(),
    }),
  ),
});

type WriteAgentNoteToolInput = z.input<typeof WriteAgentNoteInputSchema>;
type WriteAgentNoteToolOutput = z.infer<typeof WriteAgentNoteOutputSchema>;
type ReadAgentNotesToolInput = z.input<typeof ReadAgentNotesInputSchema>;
type ReadAgentNotesToolOutput = z.infer<typeof ReadAgentNotesOutputSchema>;

function sourceTaskKind(ctx: ToolContext): string {
  const bare = ctx.callerActor.ref.replace(/^agent:/i, '');
  return bare.startsWith('copilot') ? 'copilot' : bare;
}

function defaultExpiry(now: Date): string {
  return new Date(now.getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1_000).toISOString();
}

export const writeAgentNoteTool: DomainTool<WriteAgentNoteToolInput, WriteAgentNoteToolOutput> = {
  name: 'write_agent_note',
  description:
    'Leave one expiring AI-to-AI hint for copilot, dreaming, coach, maintenance, or research_meeting. Use only for a durable cross-context observation; never treat the note as learner fact or primary evidence.',
  effect: 'write',
  inputSchema: WriteAgentNoteInputSchema,
  outputSchema: WriteAgentNoteOutputSchema,
  costClass: 'local',
  mirrorEvent: 'when_causal',
  async execute(ctx, input) {
    if (ctx.callerActor.kind !== 'agent') {
      throw new ApiError('forbidden', 'write_agent_note is restricted to agent callers', 403);
    }
    const expiresAt = input.expires_at ?? defaultExpiry(new Date());
    if (new Date(expiresAt).getTime() <= Date.now()) {
      throw new ApiError('validation_error', 'expires_at must be in the future', 400);
    }
    const noteId = await writeAgentNote(ctx.db, {
      target_agents: input.target_agents as AgentNoteTarget[],
      source_task_kind: sourceTaskKind(ctx),
      source_task_run_id: ctx.taskRunId,
      refs: input.refs ?? [],
      summary_md: input.summary_md,
      signal_kind: input.signal_kind,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      expires_at: expiresAt,
      ...(ctx.causedByEventId ? { caused_by_event_id: ctx.causedByEventId } : {}),
    });
    return { status: 'written', note_id: noteId, expires_at: expiresAt };
  },
  summarize(input) {
    return `agent-note → ${input.target_agents.join(', ')}`;
  },
};

export const readAgentNotesTool: DomainTool<ReadAgentNotesToolInput, ReadAgentNotesToolOutput> = {
  name: 'read_agent_notes',
  description:
    'Read recent unexpired AI-to-AI hints for one agent. Hints only direct attention: independently verify them with first-hand evidence and never cite note ids as evidence.',
  effect: 'read',
  inputSchema: ReadAgentNotesInputSchema,
  outputSchema: ReadAgentNotesOutputSchema,
  costClass: 'local',
  mirrorEvent: 'when_causal',
  async execute(ctx, input) {
    const notes = await readAgentNotes(ctx.db, {
      for_agent: input.for_agent,
      now: new Date(),
      limit: input.limit ?? 10,
      excludeSourceKinds: [sourceTaskKind(ctx)],
    });
    return {
      notes: notes.map((note) => ({
        ...note,
        created_at: note.created_at.toISOString(),
        refs: note.refs.slice(0, MAX_REFS),
        summary_md: note.summary_md.slice(0, MAX_SUMMARY_CHARS),
      })),
    };
  },
  summarize(input, output) {
    return `agent-notes · ${input.for_agent} · ${output.notes.length}`;
  },
};

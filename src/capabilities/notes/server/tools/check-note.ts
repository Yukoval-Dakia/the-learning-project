// On-demand deterministic note check: same block-contract rules that run
// before a generated body lands, exposed to agents as issues. Read-only — it
// never blocks a write and never emits a verdict (YUK-1772).
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { noteBodyContractIssues } from '@/capabilities/notes/server/note-contract-check';
import { NoteVerificationIssue } from '@/core/schema/business';
import { artifact } from '@/db/schema';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';

const CheckNoteInputSchema = z.object({
  artifact_id: z.string().min(1),
});
type CheckNoteInput = z.input<typeof CheckNoteInputSchema>;

const CheckNoteOutputSchema = z.object({
  artifact_id: z.string(),
  artifact_type: z.string(),
  issues: z.array(NoteVerificationIssue),
});
type CheckNoteOutput = z.infer<typeof CheckNoteOutputSchema>;

async function executeCheckNote(
  ctx: ToolContext,
  rawInput: CheckNoteInput,
): Promise<CheckNoteOutput> {
  const input = CheckNoteInputSchema.parse(rawInput);
  const rows = await ctx.db
    .select({ type: artifact.type, body_blocks: artifact.body_blocks })
    .from(artifact)
    .where(eq(artifact.id, input.artifact_id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`check_note: artifact ${input.artifact_id} does not exist`);
  return {
    artifact_id: input.artifact_id,
    artifact_type: row.type,
    issues: noteBodyContractIssues(row.type, row.body_blocks),
  };
}

export const checkNoteTool: DomainTool<CheckNoteInput, CheckNoteOutput> = {
  name: 'check_note',
  description:
    'Run the deterministic structural check on a note artifact (e.g. required semantic_kind coverage for atomic notes) and return the list of issues found. Read-only diagnostic: it does not pass or fail the note and does not block any write. Use when a learner questions a note or an error signal needs confirming.',
  effect: 'read',
  inputSchema: CheckNoteInputSchema,
  outputSchema: CheckNoteOutputSchema,
  costClass: 'local',
  mirrorEvent: 'when_user_visible',
  execute: executeCheckNote,
  summarize(input, output) {
    return `check_note · ${output.artifact_type} · ${output.issues.length} issue(s)`;
  },
};

import { z } from 'zod';

export const NOTE_GENERATION_FAILURE_DETAIL_MAX = 500;
export const NOTE_GENERATION_FAILURE_ATTR = 'generation_failure';

const NoteGenerationFailureFields = {
  task_run_id: z.string().min(1).nullable(),
  detail: z.string().max(NOTE_GENERATION_FAILURE_DETAIL_MAX),
};

export const NoteGenerationFailureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('timeout'), ...NoteGenerationFailureFields }),
  z.object({ kind: z.literal('model_or_parse'), ...NoteGenerationFailureFields }),
  // Provider outage outlasted the wait budget; the terminal flip must name it.
  z.object({ kind: z.literal('provider_outage'), ...NoteGenerationFailureFields }),
  // Flipped to failed because the learner's committed body won the race.
  z.object({ kind: z.literal('learner_edited'), ...NoteGenerationFailureFields }),
]);

export type NoteGenerationFailure = z.infer<typeof NoteGenerationFailureSchema>;

export function noteGenerationFailure(
  kind: NoteGenerationFailure['kind'],
  taskRunId: string | null,
  detail: string,
): NoteGenerationFailure {
  const task_run_id = taskRunId !== null && taskRunId.length > 0 ? taskRunId : null;
  const capped =
    detail.length > NOTE_GENERATION_FAILURE_DETAIL_MAX
      ? detail.slice(0, NOTE_GENERATION_FAILURE_DETAIL_MAX)
      : detail;
  return { kind, task_run_id, detail: capped };
}

function attrsRecord(attrs: unknown): Record<string, unknown> {
  if (attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs)) {
    return { ...(attrs as Record<string, unknown>) };
  }
  return {};
}

export function readNoteGenerationFailure(attrs: unknown): NoteGenerationFailure | null {
  const parsed = NoteGenerationFailureSchema.safeParse(
    attrsRecord(attrs)[NOTE_GENERATION_FAILURE_ATTR],
  );
  return parsed.success ? parsed.data : null;
}

export function attrsWithGenerationFailure(
  attrs: unknown,
  failure: NoteGenerationFailure,
): Record<string, unknown> {
  // A terminal flip ends the wait epoch too: the receipt must die here, not on
  // a later reopen, or the re-armed epoch would inherit its spent budget.
  const next = attrsRecord(attrs);
  delete next[NOTE_GENERATION_WAIT_ATTR];
  return { ...next, [NOTE_GENERATION_FAILURE_ATTR]: failure };
}

export function attrsClearingGenerationFailure(attrs: unknown): {
  attrs: Record<string, unknown>;
  cleared: boolean;
} {
  const next = attrsRecord(attrs);
  if (!Object.hasOwn(next, NOTE_GENERATION_FAILURE_ATTR)) return { attrs: next, cleared: false };
  delete next[NOTE_GENERATION_FAILURE_ATTR];
  return { attrs: next, cleared: true };
}

// ─── provider-wait receipt (YUK-2030) ────────────────────────────────
// A pending note whose last paid call died to a proven transient provider
// rejection keeps `generation_status='pending'` and carries this receipt: the
// retry instant, the budget spent, and the unbilled evidence ref. The delayed
// wake and the handoff-recovery floor both read it; a success or a terminal
// flip clears it.

export const NOTE_GENERATION_WAIT_ATTR = 'generation_wait';

export const NoteGenerationWaitSchema = z.object({
  retry_at: z.string().datetime(),
  retry_class: z.string().min(1),
  waits: z.number().int().positive(),
  evidence_ref: z.string(),
  /**
   * pg-boss uuid of the scheduled wake, persisted BEFORE the send lands (the
   * claimNodePending ordering): the recovery floor reads it for a liveness
   * check and re-sends the same id when the wake never arrived.
   */
  wake_job_id: z.string().min(1),
});

export type NoteGenerationWait = z.infer<typeof NoteGenerationWaitSchema>;

export function readNoteGenerationWait(attrs: unknown): NoteGenerationWait | null {
  const parsed = NoteGenerationWaitSchema.safeParse(attrsRecord(attrs)[NOTE_GENERATION_WAIT_ATTR]);
  return parsed.success ? parsed.data : null;
}

export function attrsWithGenerationWait(
  attrs: unknown,
  wait: NoteGenerationWait,
): Record<string, unknown> {
  return { ...attrsRecord(attrs), [NOTE_GENERATION_WAIT_ATTR]: wait };
}

export function attrsClearingGenerationWait(attrs: unknown): {
  attrs: Record<string, unknown>;
  cleared: boolean;
} {
  const next = attrsRecord(attrs);
  if (!Object.hasOwn(next, NOTE_GENERATION_WAIT_ATTR)) return { attrs: next, cleared: false };
  delete next[NOTE_GENERATION_WAIT_ATTR];
  return { attrs: next, cleared: true };
}

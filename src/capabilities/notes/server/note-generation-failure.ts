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
  if (kind === 'timeout') return { kind: 'timeout', task_run_id, detail: capped };
  return { kind: 'model_or_parse', task_run_id, detail: capped };
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
  return { ...attrsRecord(attrs), [NOTE_GENERATION_FAILURE_ATTR]: failure };
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

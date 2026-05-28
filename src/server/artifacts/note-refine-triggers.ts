import type { Db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import type { NoteRefineTriggerKind } from '@/server/boss/handlers/note-refine';

export const NOTE_REFINE_TRIGGER_DEBOUNCE_MS = 60 * 60_000;

const FLAG_BY_KIND: Record<NoteRefineTriggerKind, string> = {
  mark_wrong: 'WAVE6_TRIGGER_MARK_WRONG_ENABLED',
  mastery_change: 'WAVE6_TRIGGER_MASTERY_ENABLED',
  error_rate: 'WAVE6_TRIGGER_CHECK_ERROR_RATE_ENABLED',
  dwell: 'WAVE6_TRIGGER_DWELL_ENABLED',
  dreaming: 'WAVE6_TRIGGER_DREAMING_ENABLED',
};

type BossSend = (
  queue: 'note_refine',
  data: {
    artifact_id: string;
    trigger: {
      kind: NoteRefineTriggerKind;
      context_md?: string;
      evidence_ids?: string[];
      trigger_event_id?: string;
    };
  },
) => Promise<unknown>;

const lastEnqueuedAt = new Map<string, number>();

export type NoteRefineTriggerResult =
  | { status: 'enqueued'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:disabled'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:debounced'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:test_env'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'failed'; artifact_id: string; kind: NoteRefineTriggerKind; error: string };

export function resetNoteRefineTriggerStateForTests(): void {
  lastEnqueuedAt.clear();
}

export function noteRefineTriggerEnabled(
  kind: NoteRefineTriggerKind,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[FLAG_BY_KIND[kind]];
  return value === undefined || value === '' || value.toLowerCase() !== 'false';
}

export async function enqueueNoteRefineTrigger(input: {
  db?: Db;
  artifactId: string;
  kind: NoteRefineTriggerKind;
  contextMd?: string;
  evidenceIds?: string[];
  triggerEventId?: string;
  now?: Date;
  bossSend?: BossSend;
  env?: NodeJS.ProcessEnv;
}): Promise<NoteRefineTriggerResult> {
  const now = input.now ?? new Date();
  if (!noteRefineTriggerEnabled(input.kind, input.env ?? process.env)) {
    return { status: 'skipped:disabled', artifact_id: input.artifactId, kind: input.kind };
  }
  const key = `${input.kind}:${input.artifactId}`;
  const last = lastEnqueuedAt.get(key);
  if (last !== undefined && now.getTime() - last < NOTE_REFINE_TRIGGER_DEBOUNCE_MS) {
    return { status: 'skipped:debounced', artifact_id: input.artifactId, kind: input.kind };
  }

  if (!input.bossSend && process.env.VITEST) {
    return { status: 'skipped:test_env', artifact_id: input.artifactId, kind: input.kind };
  }

  try {
    let send = input.bossSend;
    if (!send) {
      const boss = await getStartedBoss();
      send = boss.send.bind(boss);
    }
    await send('note_refine', {
      artifact_id: input.artifactId,
      trigger: {
        kind: input.kind,
        context_md: input.contextMd,
        evidence_ids: input.evidenceIds,
        trigger_event_id: input.triggerEventId,
      },
    });
    lastEnqueuedAt.set(key, now.getTime());
    return { status: 'enqueued', artifact_id: input.artifactId, kind: input.kind };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[note_refine:${input.kind}] enqueue failed for ${input.artifactId}:`, err);
    return { status: 'failed', artifact_id: input.artifactId, kind: input.kind, error };
  }
}

export const enqueueMarkWrongNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  blockId?: string;
  reasonMd?: string;
  triggerEventId?: string;
  bossSend?: BossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'mark_wrong',
    contextMd: [
      'User marked an artifact block as wrong.',
      input.blockId ? `block_id=${input.blockId}` : null,
      input.reasonMd ? `reason=${input.reasonMd}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

export const enqueueDwellNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  bossSend?: BossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'dwell',
    contextMd: 'User is dwelling in the editor; consider whether a small clarity patch would help.',
  });

export const enqueueErrorRateNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  questionId?: string;
  triggerEventId?: string;
  bossSend?: BossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'error_rate',
    contextMd: input.questionId
      ? `Embedded check failure for question ${input.questionId}; check error rate crossed the v0 trigger.`
      : 'Embedded check failure rate crossed the v0 trigger.',
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

export const enqueueMasteryNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  questionId?: string;
  triggerEventId?: string;
  bossSend?: BossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'mastery_change',
    contextMd: input.questionId
      ? `Review success raised mastery signal for question ${input.questionId}.`
      : 'Review success raised mastery signal.',
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

export const enqueueDreamingNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  triggerEventId?: string;
  bossSend?: BossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'dreaming',
    contextMd: 'Dreaming scan found this artifact as a Living Note refresh candidate.',
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

// Practice enqueues a note refine after failure attribution. A direct
// practice → notes value import would raise the cross-capability debt, so
// notes installs the real enqueue into this process-wide slot at host startup.

import type { Db } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';

const SLOT = 'kernel/note-refine-trigger:enqueue';

export type NoteRefineTriggerKind = 'mark_wrong' | 'mastery_change' | 'dreaming';

export interface NoteRefineTriggerEnqueueInput {
  db?: Db;
  artifactId: string;
  kind: NoteRefineTriggerKind;
  contextMd?: string;
  evidenceIds?: string[];
  triggerEventId?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export type NoteRefineTriggerEnqueueResult =
  | { status: 'enqueued'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:disabled'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:debounced'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:test_env'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'failed'; artifact_id: string; kind: NoteRefineTriggerKind; error: string };

export type NoteRefineTriggerEnqueue = (
  input: NoteRefineTriggerEnqueueInput,
) => Promise<NoteRefineTriggerEnqueueResult>;

export function installNoteRefineTrigger(enqueue: NoteRefineTriggerEnqueue): void {
  installHostOperation(SLOT, enqueue);
}

export function enqueueNoteRefineTrigger(
  input: NoteRefineTriggerEnqueueInput,
): Promise<NoteRefineTriggerEnqueueResult> {
  const enqueue = installedHostOperation<NoteRefineTriggerEnqueue>(SLOT);
  if (!enqueue) {
    throw new HostOperationNotInstalledError(
      'note refine trigger is not installed; call installNotesHostOperations at startup',
    );
  }
  return enqueue(input);
}

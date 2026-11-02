import type { NoteRefineApplyError } from '@/core/blocks/apply-note-patch';

interface QueuedPatchData {
  patch: unknown;
  taskResult?: unknown;
  triggerEventId: string | null;
  queuedAtMs: number;
  // Provenance actor of the deferred patch (`event.actor_ref` semantics). Absent
  // for the default note-refine mutator. A mutation-triggered hub sync opts out of
  // the generic force-apply ceiling, so its deferred patch must survive stale-pending
  // pruning instead of being dropped at the TTL like an abandoned note-refine patch.
  actorRef?: string;
}

export type NoteRefineQueueEntry = QueuedPatchData &
  (
    | { state: 'pending' }
    | { state: 'draining' }
    | {
        state: 'dead';
        failure: { code: NoteRefineApplyError['code']; message: string; failedAtMs: number };
      }
  );

// Historical JSON may predate queue state; reading it must not lose an already
// admitted drain obligation.
export type SerializedQueuedPatch =
  | NoteRefineQueueEntry
  | (QueuedPatchData & { state?: undefined; drainStarted?: true });

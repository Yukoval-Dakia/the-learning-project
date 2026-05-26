import { CorrectArtifactEvent } from '@/core/schema/event';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';

// Artifact-scoped correction projection. Parallel to `corrections.ts` which
// composes event-scoped state. Per ADR-0019:
//   - section_id is taken from NoteSection.id (stable string, NOT array index)
//   - `replacement_artifact_id` (supersede target) is an artifact_id, not an
//     event_id — the shape mirrors `CorrectionStatus` from corrections.ts but
//     with the supersede field renamed for clarity at the type boundary.
//   - whole-artifact and per-section state are composed independently so that
//     a whole-artifact `retract` does not silently mask per-section `mark_wrong`
//     history (and vice versa) — UI / downstream consumers can read either.

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

export type ArtifactCorrectionStatus =
  | { state: 'active'; correction_event_id: null; replacement_artifact_id: null }
  | { state: 'retracted'; correction_event_id: string; replacement_artifact_id: null }
  | { state: 'marked_wrong'; correction_event_id: string; replacement_artifact_id: null }
  | { state: 'superseded'; correction_event_id: string; replacement_artifact_id: string };

export function activeArtifactCorrectionStatus(): ArtifactCorrectionStatus {
  return { state: 'active', correction_event_id: null, replacement_artifact_id: null };
}

export interface ArtifactCorrectionState {
  /** Whole-artifact state — composed from correct events with payload.section_id omitted. */
  whole: ArtifactCorrectionStatus;
  /** Per-section state — composed from correct events with payload.section_id present. */
  sections: Map<string, ArtifactCorrectionStatus>;
}

function rowToCorrectArtifactEventInput(row: EventRow): unknown {
  return {
    actor_kind: row.actor_kind,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome,
    payload: row.payload,
    caused_by_event_id: row.caused_by_event_id ?? undefined,
    task_run_id: row.task_run_id ?? undefined,
    cost_micro_usd: row.cost_micro_usd ?? undefined,
  };
}

function applyCorrection(
  current: ArtifactCorrectionStatus,
  correctionEventId: string,
  payload: {
    correction_kind: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
    replacement_artifact_id?: string;
  },
): ArtifactCorrectionStatus {
  switch (payload.correction_kind) {
    case 'retract':
      return {
        state: 'retracted',
        correction_event_id: correctionEventId,
        replacement_artifact_id: null,
      };
    case 'mark_wrong':
      return {
        state: 'marked_wrong',
        correction_event_id: correctionEventId,
        replacement_artifact_id: null,
      };
    case 'supersede':
      // Unreachable post-safeParse — CorrectArtifactEvent superRefine
      // enforces replacement_artifact_id for supersede. Defensive only.
      if (!payload.replacement_artifact_id) return current;
      return {
        state: 'superseded',
        correction_event_id: correctionEventId,
        replacement_artifact_id: payload.replacement_artifact_id,
      };
    case 'restore':
      return activeArtifactCorrectionStatus();
  }
}

/**
 * Compose artifact-correction state for one artifact, including both whole-artifact
 * and per-section status. Reads all `correct / subject_kind='artifact'` events for
 * the given artifact_id in (created_at, id) order and applies them. Latest applicable
 * event wins per ADR-0019; `restore` returns to active.
 */
export async function getArtifactCorrectionState(
  db: DbLike,
  artifactId: string,
): Promise<ArtifactCorrectionState> {
  const map = await getArtifactCorrectionStates(db, [artifactId]);
  return map.get(artifactId) ?? { whole: activeArtifactCorrectionStatus(), sections: new Map() };
}

/**
 * Batch variant of `getArtifactCorrectionState`. Returns a Map keyed by artifact_id.
 * Artifacts without any correction events are absent from the map; callers should
 * default to `{ whole: active, sections: empty }`.
 */
export async function getArtifactCorrectionStates(
  db: DbLike,
  artifactIds: string[],
): Promise<Map<string, ArtifactCorrectionState>> {
  const ids = Array.from(new Set(artifactIds));
  const out = new Map<string, ArtifactCorrectionState>();
  if (ids.length === 0) return out;

  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'correct'),
        eq(event.subject_kind, 'artifact'),
        inArray(event.subject_id, ids),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id));

  for (const row of rows) {
    const parsed = CorrectArtifactEvent.safeParse(rowToCorrectArtifactEventInput(row));
    if (!parsed.success) {
      console.warn('getArtifactCorrectionStates: skipping malformed correction event', {
        event_id: row.id,
        error: parsed.error,
      });
      continue;
    }

    const artifactId = parsed.data.subject_id;
    const { section_id, correction_kind, replacement_artifact_id } = parsed.data.payload;

    let state = out.get(artifactId);
    if (!state) {
      state = { whole: activeArtifactCorrectionStatus(), sections: new Map() };
      out.set(artifactId, state);
    }

    if (section_id === undefined) {
      state.whole = applyCorrection(state.whole, row.id, {
        correction_kind,
        replacement_artifact_id,
      });
    } else {
      const current = state.sections.get(section_id) ?? activeArtifactCorrectionStatus();
      state.sections.set(
        section_id,
        applyCorrection(current, row.id, { correction_kind, replacement_artifact_id }),
      );
    }
  }

  return out;
}

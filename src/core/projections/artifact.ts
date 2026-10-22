import { z } from 'zod';
import { applyNotePatch } from '../blocks/apply-note-patch';
import {
  ArtifactCreateExperimental,
  ArtifactLifecycleExperimental,
  BodyBlocksEditExperimental,
  NoteRefineUndoExperimental,
} from '../schema/event/artifact-events';
import {
  ArtifactRowSnapshot,
  type ArtifactRowSnapshotT,
  GenesisExperimental,
} from '../schema/event/genesis';
import { NotePatchOp } from '../schema/note-patch';
import type { FoldEvent } from './fold-event';

/** Events that can establish or mutate artifact state; proposals are not state. */
export const ARTIFACT_STATE_ACTIONS: readonly string[] = [
  'experimental:artifact_create',
  'experimental:genesis',
  'experimental:body_blocks_edit',
  'experimental:artifact_lifecycle',
  'experimental:note_refine_apply',
  'experimental:note_refine_undo',
];

// Pure artifact reducer. artifact_create and genesis both carry a full snapshot and the
// first base wins, so a duplicate seed cannot clobber state. body_blocks_edit carries the
// after state verbatim (last-write-wins; the guard belongs to the write gate). Every
// artifact event keys on artifact id, so the gather is Q1-only.
//
// The legacy note_refine_apply event is the one op-replay exception: replaying it with
// the guard off reproduces an already-applied change. New writes use body_blocks_edit.
const NoteRefineApplyPayload = z.object({
  ops: z.array(NotePatchOp),
  // Verbatim version so a writer change to the bump rule cannot silently drift the fold.
  next_artifact_version: z.number().int().nonnegative(),
});

// Rebuild the parse input from the flat row so every branch validates its own payload.
function toParseInput(fe: FoldEvent): unknown {
  return {
    actor_kind: fe.actor_kind,
    actor_ref: fe.actor_ref,
    action: fe.action,
    subject_kind: fe.subject_kind,
    subject_id: fe.subject_id,
    outcome: fe.outcome,
    payload: fe.payload,
    caused_by_event_id: fe.caused_by_event_id ?? undefined,
  };
}

// Canonical event order, shared by every sibling reducer.
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldArtifact: skipping malformed event', { action, event_id: eventId, error });
}

// Copy the arrays the fold mutates; nested jsonb is always replaced wholesale, so a shallow
// clone keeps the reducer pure without aliasing the input payload.
function seedRow(snapshot: ArtifactRowSnapshotT): ArtifactRowSnapshotT {
  return {
    ...snapshot,
    knowledge_ids: [...snapshot.knowledge_ids],
    history: [...snapshot.history],
  };
}

/**
 * Project one artifact from its events; callers may pass a superset. Returns null when no
 * create/genesis base exists.
 */
export function foldArtifact(artifactId: string, events: FoldEvent[]): ArtifactRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: ArtifactRowSnapshotT | null = null;

  for (const fe of ordered) {
    if (!ARTIFACT_STATE_ACTIONS.includes(fe.action)) continue;
    if (fe.subject_kind !== 'artifact' || fe.subject_id !== artifactId) continue;

    // ---------- BASE: artifact_create (runtime creation, fork #2) ----------
    if (fe.action === 'experimental:artifact_create') {
      if (row !== null) continue; // FIRST BASE WINS
      const c = ArtifactCreateExperimental.safeParse(toParseInput(fe));
      if (!c.success) {
        warnMalformed('experimental:artifact_create', fe.id, c.error);
        continue;
      }
      row = seedRow(c.data.payload.row);
      continue;
    }

    // ---------- BASE: genesis (backfill seed of a pre-W3 row) ----------
    if (fe.action === 'experimental:genesis') {
      if (row !== null) continue; // FIRST BASE WINS
      const g = GenesisExperimental.safeParse(toParseInput(fe));
      if (!g.success) {
        warnMalformed('experimental:genesis', fe.id, g.error);
        continue;
      }
      // Re-parse defensively against the row snapshot, like the sibling reducers.
      const seed = ArtifactRowSnapshot.safeParse(g.data.payload.row);
      if (!seed.success) {
        warnMalformed('experimental:genesis(row)', fe.id, seed.error);
        continue;
      }
      row = seedRow(seed.data);
      continue;
    }

    // From here a base must exist (the edit/lifecycle/refine events mutate an already-seeded row).
    if (row === null) continue;

    // ---------- body_blocks_edit — full-snapshot replace (last-write-wins) ----------
    if (fe.action === 'experimental:body_blocks_edit') {
      const e = BodyBlocksEditExperimental.safeParse(toParseInput(fe));
      if (!e.success) {
        warnMalformed('experimental:body_blocks_edit', fe.id, e.error);
        continue;
      }
      row = {
        ...row,
        body_blocks: e.data.payload.body_blocks,
        // The payload is the only source of the after-history.
        history: [...e.data.payload.history_after],
        version: e.data.payload.next_artifact_version,
        updated_at: fe.created_at,
      };
      continue;
    }

    // ---------- artifact_lifecycle — presence-based apply ----------
    // Apply every carried column, so one event can reproduce a writer that touched several.
    // Undefined means untouched and must not clear anything. Version is taken verbatim.
    if (fe.action === 'experimental:artifact_lifecycle') {
      const l = ArtifactLifecycleExperimental.safeParse(toParseInput(fe));
      if (!l.success) {
        warnMalformed('experimental:artifact_lifecycle', fe.id, l.error);
        continue;
      }
      const p = l.data.payload;
      const next: ArtifactRowSnapshotT = {
        ...row,
        version: p.next_version,
        updated_at: fe.created_at,
      };
      // A carried null clears; undefined leaves the column unchanged.
      if (p.archived_at !== undefined) next.archived_at = p.archived_at;
      if (p.generation_status !== undefined) next.generation_status = p.generation_status;
      if (p.verification_status !== undefined) next.verification_status = p.verification_status;
      if (p.verification_summary !== undefined) next.verification_summary = p.verification_summary;
      if (p.generated_by !== undefined) next.generated_by = p.generated_by;
      if (p.verified_by !== undefined) next.verified_by = p.verified_by;
      // set_attrs replaces wholesale; the clone keeps the reducer pure.
      if (p.attrs !== undefined) next.attrs = p.attrs;
      if (p.history_after !== undefined) next.history = [...p.history_after];
      row = next;
      continue;
    }

    // ---------- note_refine_apply — fold-only op replay; history is untouched ----------
    if (fe.action === 'experimental:note_refine_apply') {
      const parsed = NoteRefineApplyPayload.safeParse(fe.payload);
      if (!parsed.success) {
        warnMalformed('experimental:note_refine_apply', fe.id, parsed.error);
        continue;
      }
      try {
        // Guard off: the event already represents an applied change.
        const nextBody = applyNotePatch(
          row.body_blocks,
          { ops: parsed.data.ops },
          { enforceUserVerifiedGuard: false },
        );
        row = {
          ...row,
          body_blocks: nextBody,
          version: parsed.data.next_artifact_version,
          updated_at: fe.created_at,
        };
      } catch (err) {
        // Ops no longer apply to the running body. Warn and leave the row untouched; the
        // parity harness surfaces this as drift rather than a fold crash.
        warnMalformed('experimental:note_refine_apply(replay)', fe.id, err);
      }
      continue;
    }

    // ---------- note_refine_undo — verbatim body restore (no op replay) ----------
    if (fe.action === 'experimental:note_refine_undo') {
      const u = NoteRefineUndoExperimental.safeParse(toParseInput(fe));
      if (!u.success) {
        warnMalformed('experimental:note_refine_undo', fe.id, u.error);
        continue;
      }
      const p = u.data.payload;
      // Legacy loose undo (no carried body) belongs to a pre-W3 row; skip it.
      if (p.body_blocks === undefined || p.next_artifact_version === undefined) {
        continue;
      }
      row = {
        ...row,
        body_blocks: p.body_blocks,
        version: p.next_artifact_version,
        // Undo leaves history unchanged; absent means keep the running value.
        history: p.history_after !== undefined ? [...p.history_after] : row.history,
        updated_at: fe.created_at,
      };
      // biome-ignore lint/complexity/noUselessContinue: defensive — keeps every reducer branch uniformly terminated so appending a branch can't introduce silent fall-through.
      continue;
    }
  }

  return row;
}

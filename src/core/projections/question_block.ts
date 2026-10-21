import {
  GenesisExperimental,
  QuestionBlockRowSnapshot,
  type QuestionBlockRowSnapshotT,
} from '../schema/event/genesis';
import {
  EditQuestionBlockStructuredExperimental,
  QuestionBlockCreateExperimental,
  QuestionBlockLifecycleExperimental,
} from '../schema/event/question-block-events';
import type { FoldEvent } from './fold-event';

// Pure question_block reducer. Create applies its full snapshot last-write-wins because
// a rescue re-creates the block; genesis is a backfill seed and first-base-wins.
//
// Structured edits key on the primary block: the primary takes the after tree, while an
// absorbed source only flips to ignored with its version verbatim. updated_at always
// comes from the event, never a snapshot. Gather is Q1 plus edits that absorbed this
// block as a merged source.

// Rebuild the parse input from the flat row so each branch validates its payload.
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

// Canonical event order, shared by the sibling reducers.
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldQuestionBlock: skipping malformed event', { action, event_id: eventId, error });
}

// Copy the arrays the fold mutates; nested jsonb is replaced wholesale, so this keeps purity.
function seedRow(snapshot: QuestionBlockRowSnapshotT): QuestionBlockRowSnapshotT {
  return {
    ...snapshot,
    source_asset_ids: [...snapshot.source_asset_ids],
    page_spans: [...snapshot.page_spans],
    figures: [...snapshot.figures],
    image_refs: [...snapshot.image_refs],
    crop_refs: [...snapshot.crop_refs],
    merged_from_block_ids: [...snapshot.merged_from_block_ids],
  };
}

/**
 * Project one block; callers may pass a superset, including edits keyed on another primary.
 * Null when no create/genesis base exists.
 */
export function foldQuestionBlock(
  blockId: string,
  events: FoldEvent[],
): QuestionBlockRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: QuestionBlockRowSnapshotT | null = null;

  for (const fe of ordered) {
    // ---------- BASE: question_block_create — last-write-wins; rescue re-creates ----------
    if (
      fe.subject_kind === 'question_block' &&
      fe.subject_id === blockId &&
      fe.action === 'experimental:question_block_create'
    ) {
      const c = QuestionBlockCreateExperimental.safeParse(toParseInput(fe));
      if (!c.success) {
        warnMalformed('experimental:question_block_create', fe.id, c.error);
        continue;
      }
      row = seedRow(c.data.payload.row);
      continue;
    }

    // ---------- BASE: genesis — first base wins; an idempotent seed must not re-clobber ----------
    if (
      fe.subject_kind === 'question_block' &&
      fe.subject_id === blockId &&
      fe.action === 'experimental:genesis'
    ) {
      if (row !== null) continue; // FIRST BASE WINS
      const g = GenesisExperimental.safeParse(toParseInput(fe));
      if (!g.success) {
        warnMalformed('experimental:genesis', fe.id, g.error);
        continue;
      }
      // Re-parse defensively against the row snapshot, like the sibling reducers.
      const seed = QuestionBlockRowSnapshot.safeParse(g.data.payload.row);
      if (!seed.success) {
        warnMalformed('experimental:genesis(row)', fe.id, seed.error);
        continue;
      }
      row = seedRow(seed.data);
      continue;
    }

    // ---------- edit_question_block_structured — multi-row merge aggregation ----------
    // Not filtered on subject_id: an absorbed source is keyed under a different primary.
    if (
      fe.action === 'experimental:edit_question_block_structured' &&
      fe.subject_kind === 'question_block'
    ) {
      if (row === null) continue;
      const e = EditQuestionBlockStructuredExperimental.safeParse(toParseInput(fe));
      if (!e.success) {
        warnMalformed('experimental:edit_question_block_structured', fe.id, e.error);
        continue;
      }
      const blocks = e.data.payload.affected_blocks;
      const entry = blocks.find((b) => b.block_id === blockId);
      if (entry === undefined) continue; // this edit did not touch blockId

      if (entry.role === 'primary') {
        // The primary carries the after tree; figures change only on re-pointing ops.
        // A merge appends absorbed ids to merged_from_block_ids.
        const absorbedIds =
          e.data.payload.op === 'merge_questions'
            ? blocks.filter((b) => b.role === 'merged_source').map((b) => b.block_id)
            : [];
        row = {
          ...row,
          structured: entry.structured,
          figures: entry.figures ?? row.figures,
          status: entry.status,
          version: entry.version,
          merged_from_block_ids:
            absorbedIds.length > 0
              ? [...row.merged_from_block_ids, ...absorbedIds]
              : row.merged_from_block_ids,
          updated_at: fe.created_at,
        };
        continue;
      }

      // Absorbed source: flip status, take version verbatim, never re-author structured;
      // the relation lives forward on the primary's merged_from_block_ids.
      row = {
        ...row,
        status: entry.status,
        version: entry.version,
        updated_at: fe.created_at,
      };
      continue;
    }

    // ---------- question_block_lifecycle — presence-based apply ----------
    // Undefined keeps the running value, so an ignore sweep never clears imports; a
    // carried null on imported_* is an explicit revert. Version is verbatim.
    if (
      fe.action === 'experimental:question_block_lifecycle' &&
      fe.subject_kind === 'question_block' &&
      fe.subject_id === blockId
    ) {
      if (row === null) continue;
      const l = QuestionBlockLifecycleExperimental.safeParse(toParseInput(fe));
      if (!l.success) {
        warnMalformed('experimental:question_block_lifecycle', fe.id, l.error);
        continue;
      }
      const p = l.data.payload;
      const next: QuestionBlockRowSnapshotT = {
        ...row,
        version: p.next_version,
        updated_at: fe.created_at,
      };
      // Clone carried arrays so the reducer never aliases the event payload.
      if (p.figures !== undefined) next.figures = [...p.figures];
      if (p.status !== undefined) next.status = p.status;
      if (p.imported_question_id !== undefined) next.imported_question_id = p.imported_question_id;
      if (p.imported_attempt_event_id !== undefined) {
        next.imported_attempt_event_id = p.imported_attempt_event_id;
      }
      row = next;
    }
  }

  return row;
}

import { z } from 'zod';
import {
  GenesisExperimental,
  LearningItemRowSnapshot,
  type LearningItemRowSnapshotT,
} from '../schema/event/genesis';
import { RateEvent } from '../schema/event/known';
import {
  LearningItemArchiveExperimental,
  LearningItemCompleteExperimental,
  LearningItemKnowledgeIdsRewriteExperimental,
  LearningItemRelearnExperimental,
  LearningItemStateRestoreExperimental,
} from '../schema/event/learning-item-events';
import type { FoldEvent } from './fold-event';

// Minimal merge payload: from_ids are absorbed, into_id survives.
const KnowledgeMergePayloadForFold = z.object({
  from_ids: z.array(z.string()),
  into_id: z.string().min(1),
});

/**
 * Rewrite absorbed ids to the survivor, dedupe keeping first occurrence, and copy even
 * when nothing matches. Shared with the imperative applyMerge writers, so map+Set order
 * keeps reducer output byte-identical to per-fromId application.
 */
export function applyKnowledgeMergeToIds(
  ids: readonly string[],
  fromIds: ReadonlySet<string>,
  intoId: string,
): string[] {
  if (!ids.some((id) => fromIds.has(id))) return [...ids];
  const replaced = ids.map((id) => (fromIds.has(id) ? intoId : id));
  return [...new Set(replaced)];
}

// Pure learning_item reducer. Genesis is the sole seed: unlike mistake_variant, there is
// no fold-blind field, so no dedicated create event is needed. Each item folds independently
// and the tree is read via parent_learning_item_id, not the child array.
//
// Version semantics mirror the imperative writers per site: genesis verbatim, complete and
// relearn +1, archive/retract no bump. Each transition applies only when the row matches the
// imperative WHERE (terminal-status guard), otherwise it is a no-op.
//
// No IO, ids, or clocks; gather is Q1 plus accepted merges.

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
  console.warn('foldLearningItem: skipping malformed event', { action, event_id: eventId, error });
}

/** Project one item; callers may pass a superset. Null when no genesis base exists. */
export function foldLearningItem(
  itemId: string,
  events: FoldEvent[],
): LearningItemRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  // ---------- pass 1: accepted merges ----------
  // Only an accepted merge proposal may rewrite attribution; collect those propose ids.
  const acceptedProposeIds = new Set<string>();
  for (const fe of ordered) {
    if (fe.action !== 'rate') continue;
    const rate = RateEvent.safeParse(toParseInput(fe));
    if (!rate.success) continue;
    if (rate.data.payload.rating !== 'accept') continue;
    const proposeId = fe.caused_by_event_id;
    if (proposeId) acceptedProposeIds.add(proposeId);
  }

  let row: LearningItemRowSnapshotT | null = null;

  for (const fe of ordered) {
    // ---------- BASE: experimental:genesis (the sole seed; design §3②/§3⑥) ----------
    if (fe.action === 'experimental:genesis' && fe.subject_kind === 'learning_item') {
      // First base wins; backfill should seed only once, but a duplicate must not clobber.
      if (row !== null) continue;
      const g = GenesisExperimental.safeParse(toParseInput(fe));
      if (!g.success) {
        warnMalformed('experimental:genesis', fe.id, g.error);
        continue;
      }
      if (g.data.subject_id !== itemId) continue;
      const seed = LearningItemRowSnapshot.safeParse(g.data.payload.row);
      if (!seed.success) {
        warnMalformed('experimental:genesis(row)', fe.id, seed.error);
        continue;
      }
      row = { ...seed.data, knowledge_ids: [...seed.data.knowledge_ids] };
      continue;
    }

    if (row === null) continue;

    if (
      fe.action === 'experimental:learning_item_knowledge_ids_rewrite' &&
      fe.subject_id === itemId
    ) {
      const rewrite = LearningItemKnowledgeIdsRewriteExperimental.safeParse(toParseInput(fe));
      if (!rewrite.success) {
        warnMalformed(fe.action, fe.id, rewrite.error);
        continue;
      }
      row = {
        ...row,
        knowledge_ids: applyKnowledgeMergeToIds(
          row.knowledge_ids,
          new Set([rewrite.data.payload.from_id]),
          rewrite.data.payload.into_id,
        ),
      };
      continue;
    }

    if (fe.action === 'experimental:learning_item_state_restore' && fe.subject_id === itemId) {
      const restore = LearningItemStateRestoreExperimental.safeParse(toParseInput(fe));
      if (!restore.success) {
        warnMalformed(fe.action, fe.id, restore.error);
        continue;
      }
      const payload = restore.data.payload;
      if (row.status !== payload.expected_status) continue;
      row = {
        ...row,
        status: payload.status,
        completed_at: payload.completed_at === null ? null : new Date(payload.completed_at),
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      continue;
    }

    // ---------- complete — status→done, version+1 ----------
    // Mirrors acceptCompletionProposal, including its archived/null status guard.
    if (
      fe.action === 'experimental:learning_item_complete' &&
      fe.subject_kind === 'learning_item' &&
      fe.subject_id === itemId
    ) {
      const c = LearningItemCompleteExperimental.safeParse(toParseInput(fe));
      if (!c.success) {
        warnMalformed('experimental:learning_item_complete', fe.id, c.error);
        continue;
      }
      // Exact mirror of the imperative WHERE, including archived_at IS NULL.
      if ((row.status !== 'pending' && row.status !== 'in_progress') || row.archived_at !== null) {
        continue;
      }
      row = {
        ...row,
        status: 'done',
        completed_at: fe.created_at,
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      continue;
    }

    // ---------- relearn — status→in_progress, completed_at=null, version+1 ----------
    // Mirrors acceptRelearnProposal. completed_at stays null: the original time is not restorable.
    if (
      fe.action === 'experimental:learning_item_relearn' &&
      fe.subject_kind === 'learning_item' &&
      fe.subject_id === itemId
    ) {
      const r = LearningItemRelearnExperimental.safeParse(toParseInput(fe));
      if (!r.success) {
        warnMalformed('experimental:learning_item_relearn', fe.id, r.error);
        continue;
      }
      // Exact mirror of the imperative WHERE, including archived_at IS NULL.
      if ((row.status !== 'done' && row.status !== 'resting') || row.archived_at !== null) {
        continue;
      }
      row = {
        ...row,
        status: 'in_progress',
        completed_at: null,
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      continue;
    }

    // ---------- archive — no version bump, idempotent on already-archived ----------
    // Mirrors the bare retract UPDATE; a second archive must not overwrite the first.
    if (
      fe.action === 'experimental:learning_item_archive' &&
      fe.subject_kind === 'learning_item' &&
      fe.subject_id === itemId
    ) {
      const a = LearningItemArchiveExperimental.safeParse(toParseInput(fe));
      if (!a.success) {
        warnMalformed('experimental:learning_item_archive', fe.id, a.error);
        continue;
      }
      if (row.archived_at !== null) continue;
      row = {
        ...row,
        archived_at: fe.created_at,
        archived_reason: a.data.payload.reason,
        updated_at: fe.created_at,
      };
      continue;
    }

    // ---------- knowledge_ids merge rewrite ----------
    // A merge proposal's subject is the surviving knowledge node, so it reaches this reducer
    // via the gather. Apply only when accepted; only knowledge_ids changes (no version or
    // updated_at bump), and unrelated merges are a no-op.
    if (fe.action === 'experimental:knowledge_merge' && fe.subject_kind === 'knowledge') {
      if (!acceptedProposeIds.has(fe.id)) continue; // pending / dismissed / rolled-back → no rewrite
      const m = KnowledgeMergePayloadForFold.safeParse(fe.payload);
      if (!m.success) {
        warnMalformed('experimental:knowledge_merge', fe.id, m.error);
        continue;
      }
      // Capture as const: narrowing does not survive into the closure, and the annotation
      // breaks the loop-carried type cycle (TS7022).
      const prevIds: string[] = row.knowledge_ids;
      const nextIds = applyKnowledgeMergeToIds(prevIds, new Set(m.data.from_ids), m.data.into_id);
      if (nextIds.length === prevIds.length && nextIds.every((id, i) => id === prevIds[i])) {
        continue; // no change — leave the row (and its updated_at/version) untouched
      }
      row = { ...row, knowledge_ids: nextIds };
      // biome-ignore lint/complexity/noUselessContinue: OCR O7 — explicit branch terminator so a branch added below later cannot fall through (every sibling branch above ends with continue).
      continue;
    }
  }

  return row;
}

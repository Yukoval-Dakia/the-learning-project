import {
  GenesisExperimental,
  ItemCalibrationRowSnapshot,
  type ItemCalibrationRowSnapshotT,
} from '../schema/event/genesis';
import type { FoldEvent } from './fold-event';

// Anchor-only reducer: item_calibration has no runtime mutations, so the only input is
// the genesis snapshot. Latest anchor wins.
// Imperative post-anchor writes are invisible here, so audit:projection reports drift
// until re-anchored; that is the honest event=truth signal.

// Rebuild the parse input from the flat row so a malformed payload is rejected.
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
  console.warn('foldItemCalibration: skipping malformed event', {
    action,
    event_id: eventId,
    error,
  });
}

/** Latest genesis snapshot for the row, or null when it was never anchored. */
export function foldItemCalibration(
  rowId: string,
  events: FoldEvent[],
): ItemCalibrationRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: ItemCalibrationRowSnapshotT | null = null;

  for (const fe of ordered) {
    if (
      fe.subject_kind !== 'item_calibration' ||
      fe.subject_id !== rowId ||
      fe.action !== 'experimental:genesis'
    ) {
      continue;
    }
    const g = GenesisExperimental.safeParse(toParseInput(fe));
    if (!g.success) {
      warnMalformed('experimental:genesis', fe.id, g.error);
      continue;
    }
    // Re-parse defensively against the row snapshot, like the sibling reducers.
    const seed = ItemCalibrationRowSnapshot.safeParse(g.data.payload.row);
    if (!seed.success) {
      warnMalformed('experimental:genesis(row)', fe.id, seed.error);
      continue;
    }
    // Latest anchor wins; keep iterating in canonical order.
    row = { ...seed.data };
  }

  return row;
}

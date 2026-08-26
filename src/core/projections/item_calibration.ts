import {
  GenesisExperimental,
  ItemCalibrationRowSnapshot,
  type ItemCalibrationRowSnapshotT,
} from '../schema/event/genesis';
import type { FoldEvent } from './fold-event';

// ====================================================================
// foldItemCalibration — the YUK-496 genesis-anchor fold for a single `item_calibration` row.
// PURE item_calibration reducer (ADR-0044 §7 item_calibration 例外, 方案 A).
// ====================================================================
//
// Projects the current state of ONE item_calibration row (`rowId`) from the event log. UNLIKE
// every W1/W2/W3 sibling, item_calibration has NO runtime create / mutation events: its rows are
// born from `runItemPriorBackfill` → `applyItemPrior` direct INSERTs and mutated by
// kt-calibration / recalibration UPDATEs (owner 方案 A decision, 2026-08-26: 不动 B1 在线写逻辑).
// The ONLY event the fold ever consumes is the `experimental:genesis` anchor the backfill seeds
// per row, whose payload.row snapshots the row's CURRENT values — so the fold is ANCHOR-ONLY:
//
//     fold(latest genesis for rowId) == the snapshot, byte for byte (b / confidence / …).
//
// LATEST-ANCHOR WINS (deliberate divergence from question_block's genesis FIRST-base-wins): the
// W-doctrine "first base wins" protects a mutation-reducer's output from being clobbered by a
// duplicate backfill seed. item_calibration HAS no mutation reducers — the anchor IS the fold's
// only input — so if a row ever carries more than one genesis (e.g. an explicit re-anchor after
// an out-of-band recalibration write), the newest anchor is by construction the current canonical
// snapshot. Deterministic either way: (created_at asc, id asc) order, keep-last.
//
// PLAN A BOUNDARY (documented, ticket-scoped): an imperative write that lands AFTER the anchor
// (nightly KT kt_json sink, recalibration b_calib firm-up) is invisible to the log, so
// audit:projection reports the row as DRIFT until it is re-anchored / allowlisted — the honest
// event=truth signal 方案 A accepts, and the concrete push toward the future canonical-event
// route (方案 B / YUK-405 attempt+fixed_anchor deterministic fold).
//
// PURITY CONTRACT (identical to every sibling reducer): no IO, no DB, no newId(), no Date.now()
// / new Date(). Same input → byte-identical output. Determinism is what makes
// fold(events) == row a checkable invariant.
//
// GATHER STRATEGY: Q1 ONLY (subject_kind='item_calibration' AND subject_id=rowId) — the row id
// is always the genesis event's subject_id (no minting indirection, no caused_by chain, and the
// table does NOT enter materialized_id_index — the question_block §5.3 precedent). The IO shell
// (src/server/projections/item_calibration.ts) owns the gather; the reducer is correct on any
// superset.

// toParseInput — reconstruct the Zod parse input from the flat FoldEvent columns (mirrors every
// sibling reducer). The typed branch feeds this to GenesisExperimental so a malformed payload is
// rejected at the reducer boundary rather than trusted.
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

// Stable (created_at asc, id asc) comparator — the canonical event read order (identical tiebreak
// to every sibling reducer).
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

/**
 * Pure anchor-only fold of a single `item_calibration` row from the event log.
 *
 * @param rowId   the item_calibration row id to project.
 * @param events  ALL candidate events (flat FoldEvent rows). The reducer internally SELECTS which
 *                affect `rowId` — callers pass a superset (the IO shell narrows via the Q1 gather
 *                first, but the reducer must be correct on a superset too).
 * @returns the projected row (the LATEST genesis anchor's payload.row), or `null` if `rowId` was
 *          never anchored (no genesis event keyed on it).
 */
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
    // The envelope is a generic genesis (subject_kind already filtered to 'item_calibration'
    // above); the genesis superRefine guarantees its payload.row is an item_calibration snapshot,
    // but re-parse defensively against ItemCalibrationRowSnapshot (mirror sibling reducers).
    const seed = ItemCalibrationRowSnapshot.safeParse(g.data.payload.row);
    if (!seed.success) {
      warnMalformed('experimental:genesis(row)', fe.id, seed.error);
      continue;
    }
    // LATEST-ANCHOR WINS — see the module docblock (no mutation reducers to protect).
    row = { ...seed.data };
  }

  return row;
}

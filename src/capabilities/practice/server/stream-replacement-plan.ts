type ReplacementRow = {
  readonly id: string;
  readonly ref_id: string;
  readonly position: number;
};

type ReplacementSignal = {
  readonly refId: string;
  readonly recallLocked?: boolean;
};

type StreamReplacementBasis<Row extends ReplacementRow, Signal extends ReplacementSignal> = {
  readonly rows: readonly Row[];
  readonly replaceableRows: readonly Row[];
  readonly baseKeptRefs: ReadonlySet<string>;
  readonly samplable: Signal[];
  readonly targetCount: number;
};

/** Prepare replacement slots after the caller has resolved eligibility and fresh signals. */
export function prepareStreamReplacement<
  Row extends ReplacementRow,
  Signal extends ReplacementSignal,
>(
  rows: readonly Row[],
  pendingNonDue: readonly Row[],
  signals: readonly Signal[],
): StreamReplacementBasis<Row, Signal> | null {
  // A row that freshly classifies as recall stays in place (fail-closed); never drop it
  // into a freed slot.
  const freshRecallRefs = new Set(
    signals.filter((s) => s.recallLocked === true).map((s) => s.refId),
  );
  const samplable = signals.filter((s) => s.recallLocked !== true);

  const replaceableRows = pendingNonDue
    .filter((r) => !freshRecallRefs.has(r.ref_id))
    .sort((a, b) => a.position - b.position);
  if (replaceableRows.length === 0) return null;
  const replaceableRefs = new Set(replaceableRows.map((r) => r.ref_id));

  // Compute the base set before deciding deletions; surviving replaceable refs are
  // added back when planning the sampled replacements.
  const baseKeptRefs = new Set(
    rows.filter((r) => !replaceableRefs.has(r.ref_id)).map((r) => r.ref_id),
  );

  return { rows, replaceableRows, baseKeptRefs, samplable, targetCount: replaceableRows.length };
}

/** Plan deletions and insertion attempts; the caller retains actual DB conflict feedback. */
export function planStreamReplacement<
  Row extends ReplacementRow,
  Signal extends ReplacementSignal,
  Sampled extends { readonly refId: string },
>(
  basis: StreamReplacementBasis<Row, Signal>,
  sampled: readonly Sampled[],
): {
  readonly deleteIds: string[];
  readonly vacatedPositions: number[];
  readonly insertCandidates: Sampled[];
} | null {
  const { rows, replaceableRows, baseKeptRefs } = basis;
  // Count each new ref once to bound deletions; insertion attempts keep sampled duplicates.
  const newRefPicks: string[] = [];
  const seenNewRef = new Set<string>();
  for (const s of sampled) {
    if (baseKeptRefs.has(s.refId)) continue; // 已在流里且不删 → 不是「换进的新项」。
    if (seenNewRef.has(s.refId)) continue; // 去重（同 ref 只占一个 slot）。
    seenNewRef.add(s.refId);
    newRefPicks.push(s.refId);
  }
  const deleteCount = Math.min(newRefPicks.length, replaceableRows.length);
  const rowsToDelete = replaceableRows.slice(0, deleteCount); // 最低 position 的 deleteCount 个。
  const deletedRefs = new Set(rowsToDelete.map((r) => r.ref_id));
  const vacatedPositions = rowsToDelete.map((r) => r.position).sort((a, b) => a - b);

  // Rows that survive this rerank cannot be reinserted.
  const keptRefs = new Set(rows.filter((r) => !deletedRefs.has(r.ref_id)).map((r) => r.ref_id));

  // Nothing to delete means nothing to insert.
  if (rowsToDelete.length === 0) return null;

  return {
    deleteIds: rowsToDelete.map((r) => r.id),
    vacatedPositions,
    insertCandidates: sampled.filter((s) => !keptRefs.has(s.refId)),
  };
}

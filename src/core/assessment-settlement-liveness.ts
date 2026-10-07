/** Scheduling may survive a verdict replacement when it came from a user rating. */
export function settlementReversions(
  rows: readonly {
    id: string;
    supersedesSettlementEventId: string | null;
    revertedIds: readonly string[];
    replayOf: string | null;
    fsrsApplied: readonly string[];
  }[],
) {
  const dead = new Set<string>();
  const deadFsrs = new Set<string>();
  for (const row of rows) {
    for (const id of row.revertedIds) {
      if (id !== row.supersedesSettlementEventId || row.fsrsApplied.length > 0) deadFsrs.add(id);
    }
    if (row.replayOf) deadFsrs.add(row.replayOf);
    if (row.supersedesSettlementEventId) dead.add(row.supersedesSettlementEventId);
    for (const id of row.revertedIds) dead.add(id);
    if (row.replayOf) dead.add(row.replayOf);
  }
  return { dead, deadFsrs };
}

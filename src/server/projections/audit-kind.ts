// Per-kind projection audit policy built on the registry's single read pass. The value
// audit compares fold to live values; the symmetric audit also checks the row set and
// isolates per-id fold throws. Both are read-only.
//
// Consumed by scripts/ops-projection.ts, scripts/b3-gate.ts, and the oracle sweep.

import { diffSnapshots } from '@/core/projections/snapshot-diff';
import type { Db, Tx } from '@/db/client';
import { PROJECTION_ENTITIES, type ProjectionKind } from './entity-registry';

type DbLike = Db | Tx;

export interface AllowlistEntry {
  reason: string;
  resolves_when: {
    kind: 'pr' | 'phase' | 'manual';
    ref: string;
    expected_by: string;
  };
}
export type ProjectionAllowlist = Record<string, AllowlistEntry>;

export interface DriftRecord {
  id: string;
  subject_kind: ProjectionKind;
  // human-readable field-level differences (column: live → expected).
  diffs: string[];
}

/** Per-kind audit outcome: rows checked + the drift split into non-allowlisted (failures) and allowed. */
export interface KindAuditResult {
  checked: number;
  drift: DriftRecord[];
  allowed: DriftRecord[];
}

// Push a drift record (into `allowed` if allowlisted, else `drift`) when the deep-diff found any.
function classify(
  id: string,
  subject_kind: ProjectionKind,
  diffs: string[],
  allowlist: ProjectionAllowlist,
  drift: DriftRecord[],
  allowed: DriftRecord[],
): void {
  if (diffs.length === 0) return;
  const rec: DriftRecord = { id, subject_kind, diffs };
  (allowlist[id] ? allowed : drift).push(rec);
}

/**
 * Re-derive fold(events) for every live row of one `kind` and deep-diff the structural
 * columns. Read-only. A fold throw propagates: the b3 gate uses it as a topology NO-GO
 * and must not see it downgraded to a drift count.
 */
export async function auditProjectionKind(
  db: DbLike,
  kind: ProjectionKind,
  allowlist: ProjectionAllowlist = {},
): Promise<KindAuditResult> {
  const drift: DriftRecord[] = [];
  const allowed: DriftRecord[] = [];
  // One registry read pass: live snapshots plus a prefetch-primed foldOne.
  const { liveSnapshots, foldOne } = await PROJECTION_ENTITIES[kind].gatherWithContext(db);
  for (const [id, liveSnap] of liveSnapshots) {
    const expected = await foldOne(id); // throws propagate — see docblock (O9)
    const diffs = diffSnapshots(liveSnap, expected);
    classify(id, kind, diffs, allowlist, drift, allowed);
  }
  return { checked: liveSnapshots.size, drift, allowed };
}

// ── Symmetric rowset + value audit ──────────────────────────────────────────────────────────────
//
// Over the full id universe (live rows, event subjects, index anchors), detect out-of-band
// value changes on anchored rows (FIELD_DRIFT), rows the log implies but are not live
// (GHOST), and anchored live rows that fold to null (MISSING). Un-anchored ids are skipped:
// a pre-event row folds to null and would false-positive. Callers must hold one REPEATABLE
// READ transaction so the row and event reads share a snapshot.

export type SymmetricVerdict = 'CLEAN' | 'GHOST' | 'MISSING' | 'FIELD_DRIFT';

export interface SymmetricRecord {
  id: string;
  kind: ProjectionKind;
  verdict: Exclude<SymmetricVerdict, 'CLEAN'>;
  diffs: string[];
}

/**
 * Symmetric (rowset + value) audit of one kind over the full id universe. Returns non-CLEAN
 * records minus allowlisted ids. Read-only; the caller supplies one REPEATABLE READ
 * transaction. A per-id fold throw is recorded as FIELD_DRIFT so one bad row cannot kill
 * the report-only sweep; the value audit above deliberately keeps throwing.
 */
export async function auditProjectionKindSymmetric(
  db: DbLike,
  kind: ProjectionKind,
  allowlist: ProjectionAllowlist = {},
): Promise<SymmetricRecord[]> {
  const adapter = PROJECTION_ENTITIES[kind];
  // Derive the live id set from the snapshot map instead of scanning the table twice.
  // adapter.liveIds stays on the interface for the rebuild path's allProjectionIds.
  const { liveSnapshots, foldOne } = await adapter.gatherWithContext(db);
  const live = new Set(liveSnapshots.keys());
  const subjects = await adapter.eventSubjectIds(db);
  const universe = [...new Set([...live, ...subjects])];
  const anchored = await adapter.withGenesisAnchor(db, universe);

  const out: SymmetricRecord[] = [];
  for (const id of universe) {
    if (allowlist[id]) continue; // known-acceptable divergence
    if (!anchored.has(id)) continue; // un-anchored row: skip, never false-positive
    let fold: Record<string, unknown> | null;
    try {
      fold = await foldOne(id);
    } catch (err) {
      // Report, don't crash. A DB error poisons the caller's tx anyway; this rescues
      // pure fold/reducer throws.
      out.push({
        id,
        kind,
        verdict: 'FIELD_DRIFT',
        diffs: [`<fold-threw>: ${err instanceof Error ? err.message : String(err)}`],
      });
      continue;
    }
    const liveSnap = liveSnapshots.get(id) ?? null;
    if (liveSnap !== null) {
      if (fold === null) {
        out.push({
          id,
          kind,
          verdict: 'MISSING',
          diffs: [
            '<fold-null>: an anchored live row folds to null (out-of-band insert / log implies deletion)',
          ],
        });
      } else {
        const diffs = diffSnapshots(liveSnap, fold);
        if (diffs.length > 0) out.push({ id, kind, verdict: 'FIELD_DRIFT', diffs });
      }
    } else if (fold !== null) {
      out.push({
        id,
        kind,
        verdict: 'GHOST',
        diffs: [
          '<ghost>: fold(events) yields a row with no live counterpart (out-of-band delete; would resurrect on flip)',
        ],
      });
    }
  }
  return out;
}

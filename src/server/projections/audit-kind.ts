// YUK-548 (worklist #5, component 3) — per-kind projection audit. YUK-549 (K10/K13) — the two
// per-kind switches that used to live here (`auditProjectionKind`'s read+fold and `buildKindScanData`)
// are gone: both now consume the ONE registry read pass, `PROJECTION_ENTITIES[kind].gatherWithContext`
// (entity-registry.ts). This module keeps only the audit POLICY on top of that read — the value audit
// (fold vs live row, throws propagate) and the symmetric rowset+value audit (anchor-gated, throws
// isolated). READ-ONLY; writes nothing.
//
// Consumers unchanged: scripts/audit-projection.ts (full-table loop), scripts/b3-gate.ts (flip gate),
// and src/capabilities/knowledge/jobs/projection_oracle_sweep.ts (Q4a symmetric leg).

import type { Db, Tx } from '@/db/client';
import { PROJECTION_ENTITIES, type ProjectionKind } from './entity-registry';
import { diffSnapshots } from './snapshot-diff';

type DbLike = Db | Tx;

// ── Allowlist shape (mirror audit-schema-allowlist.json) ──────────────────────────────
export interface AllowlistEntry {
  reason: string;
  resolves_when: {
    kind: 'pr' | 'phase' | 'manual';
    ref: string;
    expected_by: string;
  };
}
export type ProjectionAllowlist = Record<string, AllowlistEntry>;

// ── Drift representation ──────────────────────────────────────────────────────────────
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
 * Re-derive fold(events) for every live row of ONE `kind` and deep-diff against the live structural
 * columns. Returns the per-kind audit result. READ-ONLY — writes nothing.
 *
 * This is the VALUE audit (fold vs the live/imperative row). It intentionally has NO applicability
 * (genesis-anchor) gate: on a prod-CLONE that has been fully backfilled + rebuilt (the B3 gate flow)
 * every live row is anchored, so a fold-null is genuine drift. The LIVE-prod continuous oracle uses
 * a DIFFERENT, anchor-gated path (auditProjectionKindSymmetric, component 4) — see M3.
 *
 * THROW SEMANTICS (review O9, deliberate): a fold throw (the edge fold's ADR-0034 topology reject)
 * PROPAGATES out of `foldOne` and out of this function — the b3-gate depends on catching it to model
 * its audit.topologyReject NO-GO verdict; swallowing it here would silently downgrade a hard NO-GO
 * signal to a drift count. The report-only sweep path uses the symmetric audit below, which isolates
 * per-id throws instead.
 */
export async function auditProjectionKind(
  db: DbLike,
  kind: ProjectionKind,
  allowlist: ProjectionAllowlist = {},
): Promise<KindAuditResult> {
  const drift: DriftRecord[] = [];
  const allowed: DriftRecord[] = [];
  // K10 — one registry read pass: per-kind live-row snapshot map + a prefetch-primed foldOne (the
  // YUK-547 learning_item merge prefetch, the YUK-549 knowledge merge/rate prefetch, the edge mesh).
  const { liveSnapshots, foldOne } = await PROJECTION_ENTITIES[kind].gatherWithContext(db);
  for (const [id, liveSnap] of liveSnapshots) {
    const expected = await foldOne(id); // throws propagate — see docblock (O9)
    const diffs = diffSnapshots(liveSnap, expected);
    classify(id, kind, diffs, allowlist, drift, allowed);
  }
  return { checked: liveSnapshots.size, drift, allowed };
}

// ── Component 4 (Q4a): symmetric rowset + value audit ─────────────────────────────────────────
//
// The CONTINUOUS oracle's read side (§0 table): over the FULL id universe (live rows ∪ event subjects
// ∪ index anchors), detect (a) out-of-band value changes on anchored rows (FIELD_DRIFT), (b) rows the
// log implies but that are not live (GHOST — would resurrect on a flip), and (c) anchored live rows
// the log folds to null (MISSING — out-of-band insert, or the log implies deletion). It does NOT prove
// reducer correctness (that is structurally tautological on an ON entity — see §0).
//
// M3 APPLICABILITY GATE: un-anchored ids are SKIPPED (a pre-event-sourced / §9.3 data-fix row folds to
// null and would FALSE-positive as GHOST/MISSING). The gate reuses the registry's withGenesisAnchor.
// The CALLER must run this inside a single REPEATABLE READ tx (M4) so the row read + the event read
// see one snapshot — otherwise a concurrent write between them fabricates drift.

export type SymmetricVerdict = 'CLEAN' | 'GHOST' | 'MISSING' | 'FIELD_DRIFT';

export interface SymmetricRecord {
  id: string;
  kind: ProjectionKind;
  verdict: Exclude<SymmetricVerdict, 'CLEAN'>;
  diffs: string[];
}

/**
 * Symmetric (rowset + value) audit of ONE kind over the FULL id universe. Returns the NON-CLEAN
 * records (allowlisted ids excluded). READ-ONLY — writes nothing. MUST be called inside a single
 * REPEATABLE READ tx (M4). Un-anchored ids are skipped (M3).
 *
 * THROW ISOLATION (review O9): a per-id fold throw (foldKnowledgeEdge's ADR-0034 topology reject, or
 * any unanticipated reducer throw) is caught PER ID and recorded as FIELD_DRIFT with a
 * `<fold-threw>` sentinel diff (the parity.ts convention) — one bad row must never crash the whole
 * report-only sweep (a throw would propagate to the pg-boss handler → DLQ → a silent week-long
 * evidence blind spot). CONTRAST with auditProjectionKind above, which deliberately KEEPS throwing:
 * the b3-gate models the topology throw as its audit.topologyReject NO-GO verdict and must not have
 * that signal silently downgraded to a drift count.
 */
export async function auditProjectionKindSymmetric(
  db: DbLike,
  kind: ProjectionKind,
  allowlist: ProjectionAllowlist = {},
): Promise<SymmetricRecord[]> {
  const adapter = PROJECTION_ENTITIES[kind];
  // Review K7 — ONE table scan: gatherWithContext already reads every live row for the snapshot map,
  // so derive the live id set from its keys instead of a second adapter.liveIds(db) scan of the same
  // table. The universe→anchored ordering constraint is unchanged; adapter.liveIds stays on the
  // interface (the rebuild path's allProjectionIds still consumes it).
  const { liveSnapshots, foldOne } = await adapter.gatherWithContext(db);
  const live = new Set(liveSnapshots.keys());
  const subjects = await adapter.eventSubjectIds(db);
  const universe = [...new Set([...live, ...subjects])];
  const anchored = await adapter.withGenesisAnchor(db, universe);

  const out: SymmetricRecord[] = [];
  for (const id of universe) {
    if (allowlist[id]) continue; // known-acceptable divergence
    if (!anchored.has(id)) continue; // M3 — un-anchored (fold-blind) row: skip, never false-positive
    let fold: Record<string, unknown> | null;
    try {
      fold = await foldOne(id);
    } catch (err) {
      // O9 — report, don't crash (see docblock). A DB error inside the caller's tx poisons the tx
      // and fails the run regardless; this rescue is for pure fold/reducer throws.
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

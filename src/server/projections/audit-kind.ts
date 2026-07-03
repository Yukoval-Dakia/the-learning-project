// YUK-548 (worklist #5, component 3) — per-kind projection audit. The 7 inline loops that used to
// live in scripts/audit-projection.ts are hoisted here, one `auditProjectionKind(db, kind, allowlist)`
// switch, so (a) scripts/audit-projection.ts's full-table `auditProjection` becomes a thin loop over
// the registry, and (b) the Q4a projection-oracle sweep can audit a SINGLE ON kind without dragging
// in the CLI `main()` / `import './load-env'` side effects of the scripts module.
//
// The per-kind logic is byte-for-byte the extraction of the previous inline loops — same narrow
// structural reads, same shared mappers, same diffSnapshots equality (the SAME deep-diff the in-tx
// parity assert uses), same learning_item YUK-547 prefetch. READ-ONLY; writes nothing.

import type { Db, Tx } from '@/db/client';
import {
  artifact,
  goal,
  knowledge,
  knowledge_edge,
  learning_item,
  mistake_variant,
  question_block,
} from '@/db/schema';
import { PROJECTION_ENTITIES, type ProjectionKind } from './entity-registry';
import {
  edgeRowToSnapshot,
  gatherAndFoldArtifact,
  gatherAndFoldGoal,
  gatherAndFoldKnowledgeEdgeWithMesh,
  gatherAndFoldKnowledgeNode,
  gatherAndFoldLearningItem,
  gatherAndFoldMistakeVariant,
  gatherAndFoldQuestionBlock,
  prefetchLearningItemMergeEvents,
} from './gather';
// Live-row → snapshot mappers REUSED from the accept-time parity asserts (review K9): one exported
// field-pick per row shape, so the audit snapshot shape can never drift from what the parity assert
// compares (same doctrine as the snapshot-mappers import below).
import {
  goalLiveRowToSnapshot,
  knowledgeLiveRowToSnapshot,
  learningItemLiveRowToSnapshot,
  mistakeVariantLiveRowToSnapshot,
} from './parity';
import { diffSnapshots } from './snapshot-diff';
import { artifactRowToSnapshot, questionBlockRowToSnapshot } from './snapshot-mappers';

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

// The structural columns to SELECT for the node scan — ONLY the structural snapshot columns, NOT
// the large embed_* vectors (a narrow-column read keeps the full-table scan from pulling every
// node's embedding into memory at prod-clone scale). The field set must satisfy
// knowledgeLiveRowToSnapshot's inline param type — tsc enforces the sync at the call site (K9).
const KNOWLEDGE_STRUCTURAL_COLUMNS = {
  id: knowledge.id,
  name: knowledge.name,
  domain: knowledge.domain,
  parent_id: knowledge.parent_id,
  merged_from: knowledge.merged_from,
  archived_at: knowledge.archived_at,
  proposed_by_ai: knowledge.proposed_by_ai,
  approval_status: knowledge.approval_status,
  created_at: knowledge.created_at,
  updated_at: knowledge.updated_at,
  version: knowledge.version,
} as const;

// ── learning_item structural read (YUK-471 W2) ── the auditor reads ONLY the snapshot columns,
// EXCLUDING the non-structural / derived columns the fold does not own (child_learning_item_ids /
// ai_score / due_at / reviewed_at — design §3①).
const LEARNING_ITEM_STRUCTURAL_COLUMNS = {
  id: learning_item.id,
  source: learning_item.source,
  source_ref: learning_item.source_ref,
  title: learning_item.title,
  content: learning_item.content,
  knowledge_ids: learning_item.knowledge_ids,
  primary_artifact_id: learning_item.primary_artifact_id,
  parent_learning_item_id: learning_item.parent_learning_item_id,
  status: learning_item.status,
  user_pinned: learning_item.user_pinned,
  completed_at: learning_item.completed_at,
  dismissed_at: learning_item.dismissed_at,
  archived_at: learning_item.archived_at,
  archived_reason: learning_item.archived_reason,
  created_at: learning_item.created_at,
  updated_at: learning_item.updated_at,
  version: learning_item.version,
} as const;

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
 * PROPAGATES out of this function — the b3-gate depends on catching it to model its
 * audit.topologyReject NO-GO verdict; swallowing it here would silently downgrade a hard NO-GO
 * signal to a drift count. The report-only sweep path uses the symmetric audit below, which
 * isolates per-id throws instead.
 */
export async function auditProjectionKind(
  db: DbLike,
  kind: ProjectionKind,
  allowlist: ProjectionAllowlist = {},
): Promise<KindAuditResult> {
  const drift: DriftRecord[] = [];
  const allowed: DriftRecord[] = [];

  switch (kind) {
    case 'knowledge': {
      const rows = await db.select(KNOWLEDGE_STRUCTURAL_COLUMNS).from(knowledge);
      for (const row of rows) {
        const expected = await gatherAndFoldKnowledgeNode(db, row.id);
        const diffs = diffSnapshots(
          knowledgeLiveRowToSnapshot(row),
          expected as Record<string, unknown> | null,
        );
        classify(row.id, 'knowledge', diffs, allowlist, drift, allowed);
      }
      return { checked: rows.length, drift, allowed };
    }
    case 'knowledge_edge': {
      // Fetch the live topology mesh ONCE for the whole scan (the mesh is constant in a read-only
      // scan) → O(E) instead of the per-edge O(E²) re-fetch. checkEdgeTopology treats the mesh as a
      // SET, so row order is irrelevant.
      const edges = await db.select().from(knowledge_edge);
      const liveMesh = edges.filter((e) => e.archived_at === null).map(edgeRowToSnapshot);
      for (const row of edges) {
        const expected = await gatherAndFoldKnowledgeEdgeWithMesh(db, row.id, liveMesh);
        const diffs = diffSnapshots(
          edgeRowToSnapshot(row),
          expected as Record<string, unknown> | null,
        );
        classify(row.id, 'knowledge_edge', diffs, allowlist, drift, allowed);
      }
      return { checked: edges.length, drift, allowed };
    }
    case 'goal': {
      const rows = await db.select().from(goal);
      for (const row of rows) {
        const expected = await gatherAndFoldGoal(db, row.id);
        const diffs = diffSnapshots(
          goalLiveRowToSnapshot(row),
          expected as Record<string, unknown> | null,
        );
        classify(row.id, 'goal', diffs, allowlist, drift, allowed);
      }
      return { checked: rows.length, drift, allowed };
    }
    case 'mistake_variant': {
      const rows = await db.select().from(mistake_variant);
      for (const row of rows) {
        const expected = await gatherAndFoldMistakeVariant(db, row.id);
        const diffs = diffSnapshots(
          mistakeVariantLiveRowToSnapshot(row),
          expected as Record<string, unknown> | null,
        );
        classify(row.id, 'mistake_variant', diffs, allowlist, drift, allowed);
      }
      return { checked: rows.length, drift, allowed };
    }
    case 'learning_item': {
      const rows = await db.select(LEARNING_ITEM_STRUCTURAL_COLUMNS).from(learning_item);
      // YUK-547 — prefetch the item-independent merge legs ONCE for the whole scan.
      const prefetchedMergeEvents = await prefetchLearningItemMergeEvents(db);
      for (const row of rows) {
        const expected = await gatherAndFoldLearningItem(db, row.id, prefetchedMergeEvents);
        const diffs = diffSnapshots(
          learningItemLiveRowToSnapshot(row),
          expected as Record<string, unknown> | null,
        );
        classify(row.id, 'learning_item', diffs, allowlist, drift, allowed);
      }
      return { checked: rows.length, drift, allowed };
    }
    case 'artifact': {
      const rows = await db.select().from(artifact);
      for (const row of rows) {
        const expected = await gatherAndFoldArtifact(db, row.id);
        const diffs = diffSnapshots(
          artifactRowToSnapshot(row),
          expected as Record<string, unknown> | null,
        );
        classify(row.id, 'artifact', diffs, allowlist, drift, allowed);
      }
      return { checked: rows.length, drift, allowed };
    }
    case 'question_block': {
      const rows = await db.select().from(question_block);
      for (const row of rows) {
        const expected = await gatherAndFoldQuestionBlock(db, row.id);
        const diffs = diffSnapshots(
          questionBlockRowToSnapshot(row),
          expected as Record<string, unknown> | null,
        );
        classify(row.id, 'question_block', diffs, allowlist, drift, allowed);
      }
      return { checked: rows.length, drift, allowed };
    }
    default: {
      // Exhaustiveness backstop (review O10): tsconfig has neither noImplicitReturns nor
      // noUnusedLocals, so a missing case would silently return undefined — this makes a new
      // ProjectionKind a COMPILE error here and a loud runtime error if compiled around.
      const _exhaustive: never = kind;
      throw new Error(`auditProjectionKind: unhandled kind ${String(_exhaustive)}`);
    }
  }
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

interface KindScanData {
  // id → live-row snapshot (only ids with a live row).
  liveSnapshots: Map<string, Record<string, unknown>>;
  // fold(events) for one id — the SAME gather the value audit + write-through shell use.
  foldOne: (id: string) => Promise<Record<string, unknown> | null>;
}

// Build the per-kind live-snapshot map + fold closure (mirrors the value-audit per-kind reads/mappers,
// but keyed by id so the symmetric scan can look a live row up by any universe id).
async function buildKindScanData(db: DbLike, kind: ProjectionKind): Promise<KindScanData> {
  const map = new Map<string, Record<string, unknown>>();
  switch (kind) {
    case 'knowledge': {
      const rows = await db.select(KNOWLEDGE_STRUCTURAL_COLUMNS).from(knowledge);
      for (const row of rows)
        map.set(row.id, knowledgeLiveRowToSnapshot(row) as Record<string, unknown>);
      return {
        liveSnapshots: map,
        foldOne: async (id) =>
          (await gatherAndFoldKnowledgeNode(db, id)) as Record<string, unknown> | null,
      };
    }
    case 'knowledge_edge': {
      const rows = await db.select().from(knowledge_edge);
      const mesh = rows.filter((e) => e.archived_at === null).map(edgeRowToSnapshot);
      for (const row of rows) map.set(row.id, edgeRowToSnapshot(row) as Record<string, unknown>);
      return {
        liveSnapshots: map,
        foldOne: async (id) =>
          (await gatherAndFoldKnowledgeEdgeWithMesh(db, id, mesh)) as Record<
            string,
            unknown
          > | null,
      };
    }
    case 'goal': {
      const rows = await db.select().from(goal);
      for (const row of rows)
        map.set(row.id, goalLiveRowToSnapshot(row) as Record<string, unknown>);
      return {
        liveSnapshots: map,
        foldOne: async (id) => (await gatherAndFoldGoal(db, id)) as Record<string, unknown> | null,
      };
    }
    case 'mistake_variant': {
      const rows = await db.select().from(mistake_variant);
      for (const row of rows)
        map.set(row.id, mistakeVariantLiveRowToSnapshot(row) as Record<string, unknown>);
      return {
        liveSnapshots: map,
        foldOne: async (id) =>
          (await gatherAndFoldMistakeVariant(db, id)) as Record<string, unknown> | null,
      };
    }
    case 'learning_item': {
      const rows = await db.select(LEARNING_ITEM_STRUCTURAL_COLUMNS).from(learning_item);
      const prefetched = await prefetchLearningItemMergeEvents(db);
      for (const row of rows)
        map.set(row.id, learningItemLiveRowToSnapshot(row) as Record<string, unknown>);
      return {
        liveSnapshots: map,
        foldOne: async (id) =>
          (await gatherAndFoldLearningItem(db, id, prefetched)) as Record<string, unknown> | null,
      };
    }
    case 'artifact': {
      const rows = await db.select().from(artifact);
      for (const row of rows)
        map.set(row.id, artifactRowToSnapshot(row) as Record<string, unknown>);
      return {
        liveSnapshots: map,
        foldOne: async (id) =>
          (await gatherAndFoldArtifact(db, id)) as Record<string, unknown> | null,
      };
    }
    case 'question_block': {
      const rows = await db.select().from(question_block);
      for (const row of rows)
        map.set(row.id, questionBlockRowToSnapshot(row) as Record<string, unknown>);
      return {
        liveSnapshots: map,
        foldOne: async (id) =>
          (await gatherAndFoldQuestionBlock(db, id)) as Record<string, unknown> | null,
      };
    }
    default: {
      // Exhaustiveness backstop (review O10) — see auditProjectionKind's default.
      const _exhaustive: never = kind;
      throw new Error(`buildKindScanData: unhandled kind ${String(_exhaustive)}`);
    }
  }
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
  // Review K7 — ONE table scan: buildKindScanData already reads every live row for the snapshot map,
  // so derive the live id set from its keys instead of a second adapter.liveIds(db) scan of the same
  // table. The universe→anchored ordering constraint is unchanged; adapter.liveIds stays on the
  // interface (the rebuild path's allProjectionIds still consumes it).
  const { liveSnapshots, foldOne } = await buildKindScanData(db, kind);
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

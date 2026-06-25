// YUK-471 Wave 0 (deferred capstone) — cascade-revert ORCHESTRATOR.
//
// This is the cross-cutting consumer that makes the Wave-0 snapshot/cascade
// machinery usable (ADR-0044 §4 + 诚实天花板). It wires three primitives:
//   collectCascadeFromCheckpoint (cascade.ts)        → the closure to revert
//   restoreStateSnapshot         (restore-snapshot.ts) → A-class state revert
//   writeEvent action='correct'  (corrections.ts trap) → event-layer compensation
//
// ─────────────────────────────────────────────────────────────────────────────
// REVERSIBILITY TAXONOMY (ADR-0044 §4 / §100 honest-ceiling). Each cascade node
// (and the root checkpoint) maps to one class. Classification is ROW-AWARE — a
// node's class depends on (action, subject_kind, payload.edge_op), not action
// alone — because the imperative inverse differs per shape.
//
//   A-class  state_snapshot      — action='experimental:state_snapshot'.
//                                   Reversed by restoreStateSnapshot (θ̂ + FSRS
//                                   row upsert/delete) + the conflict guard below
//                                   (the restore primitive is guard-agnostic by
//                                   design — restore-snapshot.ts:16-20).
//
//   B-class  structural fold      — splits by whether a LIVE SoT row exists:
//
//     · imperative_undo  generate(knowledge_edge): a real knowledge_edge ROW
//                        exists (the imperative write path still owns it —
//                        proposals/actions.ts). Event-layer `correct` alone is a
//                        NO-OP on that row: NO poller/trigger reconciles
//                        action='correct' into the named projection, and the edge
//                        fold (gatherAndFoldKnowledgeEdge) gathers ONLY events
//                        keyed (subject_kind='knowledge_edge', subject_id=edgeId)
//                        — the cascade's `correct` (subject_kind='event') is
//                        invisible to it, so a rebuild reproduces the SAME live
//                        row. We therefore mirror the established retract dual-
//                        write (retractAiProposal, actions.ts:1001-1049): archive
//                        the edge row IN the same tx (create-generate → archive;
//                        archive-generate → un-archive) AND write the `correct`.
//
//     · event_layer      conversational mirrors (copilot_reply / teach_message),
//                        checkpoint anchors (copilot_user_ask / chip_trigger),
//                        propose / rate. These have NO independent live SoT row to
//                        undo: a `propose` is a suggestion (its materialization is
//                        the chained generate, which IS in the cascade and gets
//                        its own imperative undo); a `rate` is a vote; mirrors /
//                        anchors are pure conversation history. For these the
//                        `correct`(retract) event IS the complete reversal (the
//                        proposal-inbox + conversation projections read corrections
//                        / getCorrectionStatuses).
//
//   IRREVERSIBLE                   — real learner facts: attempt / review (FSRS
//                                   register) / judge / accept_suggestion
//                                   (user_verified) / tool_use. Per 诚实天花板 §100
//                                   these cannot be undone (retract = 篡改真实历史).
//
// FAIL-CLOSED: any (action, subject_kind) shape NOT in the A/B reversible tables
// is treated as IRREVERSIBLE — we NEVER return ok:true while leaving a live SoT
// row untouched. Notably `extract` (materializes question_block rows, no clean
// cascade-driven inverse — Wave 3), `suppress`, and any generate whose subject is
// NOT knowledge_edge fall here: they refuse the whole cascade rather than silently
// no-op. (fail-loud > silent incomplete undo.)
//
// CONFLICT GUARD: before restoring an A-class snapshot, assert the CURRENT state
// row equals snapshot.after. If not (something outside the cascade moved it) →
// 409-style refuse the WHOLE revert. This guard is the orchestrator's job; the
// restore primitive deliberately omits it (restore-snapshot.ts:16-20). For float4
// columns (mastery_state.theta_hat is `real`) the compare is on the float4 grid:
// the payload's `after` is a full-precision JS double, the live row was truncated
// to single precision on write, so we compare Math.fround(after) === current.
//
// DETERMINISM: single tx, reverse-dependency order (cascade nodes are already
// depth-DESC; the root checkpoint is reverted LAST). Parse-barrier-clean: every
// snapshot payload is validated against StateSnapshotExperimental before use.

import { archiveKnowledgeEdge } from '@/capabilities/knowledge/server/edges';
import { newId } from '@/core/ids';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import {
  StateSnapshotExperimental,
  type StateSnapshotExperimentalT,
} from '@/core/schema/event/state-snapshot';
import type { Db, Tx } from '@/db/client';
import { event, knowledge_edge, mastery_state, material_fsrs_state } from '@/db/schema';
import { type CollectCascadeOptions, collectCascadeFromCheckpoint } from '@/server/events/cascade';
import { writeEvent } from '@/server/events/queries';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { restoreStateSnapshot } from './restore-snapshot';

type DbLike = Db | Tx;

/** A-class: the only action whose revert is a state-snapshot restore. */
const STATE_SNAPSHOT_ACTION = 'experimental:state_snapshot';

/**
 * B-class EVENT-LAYER actions: a `correct`(retract) event is the COMPLETE reversal
 * (no independent live SoT row to undo). Mirrors / anchors / propose / rate.
 *   - copilot_reply / teach_message : conversational history mirrors (zero θ̂ /
 *     FSRS / structural change). MED-1: copilot_reply is a depth-1 child of EVERY
 *     real per-utterance checkpoint (chat.ts:524 caused_by=userAsk), so omitting
 *     it would make the flagship clean-revert use case fail-closed-irreversible.
 *   - copilot_user_ask / chip_trigger : checkpoint ANCHOR actions (root of a
 *     per-utterance revert). Reversible utterance markers (诚实天花板 §102).
 *   - propose : a suggestion; its materialization is the chained generate (handled
 *     separately with imperative undo when present).
 *   - rate : a vote; the materialization is the chained generate.
 */
const EVENT_LAYER_ACTIONS: ReadonlySet<string> = new Set([
  'experimental:copilot_reply',
  'experimental:teach_message',
  'experimental:copilot_user_ask',
  'experimental:copilot_chip_trigger',
  'propose',
  'rate',
]);

/** The compensation actor (agent lane; non-'self' per CorrectEvent attribution). */
const CASCADE_REVERT_ACTOR_REF = 'cascade_revert';

export type ReversibilityClass =
  | 'state_snapshot'
  | 'structural_imperative'
  | 'event_layer'
  | 'irreversible';

/**
 * The imperative inverse to run for a `structural_imperative` node (B-class with a
 * live SoT row). Currently only knowledge_edge create/archive have a clean wired
 * inverse; anything else fails closed before reaching here.
 */
export type ImperativeUndo =
  | { kind: 'archive_edge'; edgeId: string }
  | { kind: 'unarchive_edge'; edgeId: string };

export interface RevertableEffect {
  eventId: string;
  action: string;
  reversibility: ReversibilityClass;
  /** Present only for reversibility === 'structural_imperative'. */
  imperativeUndo?: ImperativeUndo;
}

export interface CascadeRevertResult {
  ok: true;
  checkpointEventId: string;
  reverted: {
    /** A-class state_snapshot events restored (θ̂ / FSRS). */
    snapshotsRestored: number;
    /** B-class structural rows imperatively archived/un-archived (knowledge_edge). */
    structuralRowsArchived: number;
    /** B-class event-layer nodes reversed by the `correct` event alone. */
    eventLayerCompensated: number;
    /** Total nodes reverted (= every node got a `correct` compensation). */
    totalNodes: number;
  };
  /** Ids of the `correct` compensation events written, in apply order. */
  compensationEventIds: string[];
}

export type CascadeRevertRefusal =
  | {
      ok: false;
      refusal: 'truncated';
      reason: string;
    }
  | {
      ok: false;
      refusal: 'irreversible';
      reason: string;
      /** Event ids that are irreversible (or unknown → fail-closed). */
      irreversibleEventIds: string[];
    }
  | {
      ok: false;
      refusal: 'conflict';
      reason: string;
      /** The (subject_kind, subject_id) of the snapshot segment that conflicted. */
      conflictRef: { kind: 'theta' | 'fsrs'; subjectKind: string; subjectId: string };
    };

export type OrchestrateCascadeRevertResult = CascadeRevertResult | CascadeRevertRefusal;

export interface OrchestrateCascadeRevertOptions extends CollectCascadeOptions {}

/**
 * Classify a single event ROW into its reversibility class (fail-closed).
 * Row-aware: a generate's class depends on subject_kind + payload.edge_op.
 */
function classifyRow(row: EventRow): RevertableEffect {
  const base = { eventId: row.id, action: row.action };

  if (row.action === STATE_SNAPSHOT_ACTION) {
    return { ...base, reversibility: 'state_snapshot' };
  }

  // generate(knowledge_edge): a live knowledge_edge ROW exists → imperative undo.
  // subject_id IS the edge id (GenerateKnowledgeEdge, known.ts). edge_op='archive'
  // means the generate ARCHIVED an edge → its inverse is un-archive; otherwise the
  // generate CREATED an edge → its inverse is archive.
  if (row.action === 'generate' && row.subject_kind === 'knowledge_edge') {
    const edgeOp = (row.payload as { edge_op?: string } | null)?.edge_op;
    const undo: ImperativeUndo =
      edgeOp === 'archive'
        ? { kind: 'unarchive_edge', edgeId: row.subject_id }
        : { kind: 'archive_edge', edgeId: row.subject_id };
    return { ...base, reversibility: 'structural_imperative', imperativeUndo: undo };
  }

  if (EVENT_LAYER_ACTIONS.has(row.action)) {
    return { ...base, reversibility: 'event_layer' };
  }

  // Everything else (real learner facts, AND any structural shape with no wired
  // clean inverse — generate(artifact), extract, suppress, …) → fail-closed.
  return { ...base, reversibility: 'irreversible' };
}

/**
 * Orchestrate a cascade revert from `checkpointEventId`.
 *
 * Collects the downstream closure, classifies every node + the root, refuses the
 * WHOLE revert (no partial cascade) on truncation / irreversibility / conflict,
 * then applies the reversible effects inside ONE transaction in reverse-dependency
 * order (deepest first; root last), writing a `correct` compensation event per node.
 */
export async function orchestrateCascadeRevert(
  db: Db,
  checkpointEventId: string,
  opts?: OrchestrateCascadeRevertOptions,
): Promise<OrchestrateCascadeRevertResult> {
  // 1. Collect the cascade. Truncation → honest-reject (no half set).
  const cascade = await collectCascadeFromCheckpoint(db, checkpointEventId, opts);
  if (cascade.truncated) {
    return {
      ok: false,
      refusal: 'truncated',
      reason: `cascade from ${checkpointEventId} exceeds the depth/node limit — refusing the whole revert (a partial cascade is never applied; manual intervention required)`,
    };
  }

  // 2. Load the root checkpoint row. It is reverted LAST, after its downstream
  //    (cascade.ts excludes the root from the collected set — cascade.ts:18).
  const rootRow = await loadEventRow(db, checkpointEventId);
  if (!rootRow) {
    return {
      ok: false,
      refusal: 'irreversible',
      reason: `checkpoint event ${checkpointEventId} not found`,
      irreversibleEventIds: [checkpointEventId],
    };
  }

  // 3. Build the ordered effect list. cascade.nodes are depth-DESC (deepest
  //    first); the root checkpoint is appended LAST (reverted after everything it
  //    caused). The root is excluded from the collected nodes, so it cannot be a
  //    duplicate here.
  const orderedRows: EventRow[] = [];
  const nodeRows = await loadEventRows(
    db,
    cascade.nodes.map((n) => n.id),
  );
  for (const node of cascade.nodes) {
    const row = nodeRows.get(node.id);
    if (!row) {
      // A node vanished between collection and load (should not happen in one
      // request, but fail-closed rather than silently skip).
      return {
        ok: false,
        refusal: 'irreversible',
        reason: `cascade node ${node.id} disappeared before revert — refusing`,
        irreversibleEventIds: [node.id],
      };
    }
    orderedRows.push(row);
  }
  orderedRows.push(rootRow);

  // 4. PRE-CHECK reversibility (all-or-nothing). Any irreversible / unknown / no-
  //    clean-inverse node → refuse the whole revert naming what blocked it.
  const effects: RevertableEffect[] = orderedRows.map(classifyRow);
  const irreversible = effects.filter((e) => e.reversibility === 'irreversible');
  if (irreversible.length > 0) {
    const actionsList = irreversible.map((e) => `${e.action}(${e.eventId})`).join(', ');
    return {
      ok: false,
      refusal: 'irreversible',
      reason: `cascade from ${checkpointEventId} contains ${irreversible.length} irreversible node(s) (real attempt/review/judge/accept_suggestion/tool_use, or a structural shape with no clean cascade-driven inverse — extract/suppress/generate(artifact) — fail-closed). Per 诚实天花板 a real learner fact cannot be reverted; refusing the whole cascade rather than a partial-or-silently-incomplete one. Irreversible nodes: ${actionsList}`,
      irreversibleEventIds: irreversible.map((e) => e.eventId),
    };
  }

  // 5. PRE-CHECK the A-class conflict guard for EVERY snapshot BEFORE opening the
  //    tx, so a conflict refuses without any mutation. Parse + validate each
  //    snapshot payload here too (parse-barrier).
  const snapshotPayloads = new Map<string, StateSnapshotExperimentalPayload>();
  for (const e of effects) {
    if (e.reversibility !== 'state_snapshot') continue;
    const row = nodeRows.get(e.eventId) ?? rootRow;
    const payload = parseSnapshotPayload(row);
    snapshotPayloads.set(e.eventId, payload);
    const conflict = await assertSnapshotMatchesCurrent(db, payload);
    if (conflict) {
      return {
        ok: false,
        refusal: 'conflict',
        reason: `state_snapshot ${e.eventId} conflict: current ${conflict.kind} state for ${conflict.subjectKind}/${conflict.subjectId} != snapshot.after — something outside the cascade modified it. Refusing the whole revert.`,
        conflictRef: conflict,
      };
    }
  }

  // 6. Execute inside ONE tx: reverse-dependency order (effects already deepest-
  //    first, root last). Each reversible node gets its effect applied + a
  //    `correct` compensation event so re-collection won't re-sweep it.
  const compensationEventIds: string[] = [];
  let snapshotsRestored = 0;
  let structuralRowsArchived = 0;
  let eventLayerCompensated = 0;
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const e of effects) {
      if (e.reversibility === 'state_snapshot') {
        const payload = snapshotPayloads.get(e.eventId);
        if (!payload) {
          // Defensive: every snapshot was parsed in step 5.
          throw new Error(`snapshot payload for ${e.eventId} missing in apply phase`);
        }
        // Re-assert the conflict guard inside the tx (defence-in-depth against a
        // concurrent writer between pre-check and tx). A conflict here throws to
        // roll back the whole tx — the pre-check already returned the typed
        // refusal in the common case.
        const conflict = await assertSnapshotMatchesCurrent(tx, payload);
        if (conflict) {
          throw new CascadeRevertConflictError(e.eventId, conflict);
        }
        await restoreStateSnapshot(tx, payload);
        snapshotsRestored += 1;
      } else if (e.reversibility === 'structural_imperative') {
        // B-class with a live SoT row — mirror the established retract dual-write:
        // archive/un-archive the row in THIS tx AND write the `correct` below.
        await applyImperativeUndo(tx, e.imperativeUndo);
        structuralRowsArchived += 1;
      } else {
        // event_layer → the `correct`(retract) below IS the complete reversal.
        eventLayerCompensated += 1;
      }

      // Write the compensation `correct`(retract) event for EVERY reverted node so
      // a re-collection skips it (cascade.ts drops action='correct' children + the
      // getCorrectionStatuses fold honours it). For structural_imperative this is
      // BELT-AND-BRACES with the imperative archive above (so a future SoT-flip
      // re-projection that DOES read corrections stays consistent).
      const compId = newId();
      await writeEvent(tx, {
        id: compId,
        actor_kind: 'agent',
        actor_ref: CASCADE_REVERT_ACTOR_REF,
        action: 'correct',
        subject_kind: 'event',
        subject_id: e.eventId,
        outcome: 'success',
        payload: {
          correction_kind: 'retract',
          reason_md: `cascade revert of checkpoint ${checkpointEventId} (${e.reversibility})`,
          affected_refs: [{ kind: 'open_inquiry', id: e.eventId }],
        },
        caused_by_event_id: e.eventId,
        created_at: now,
        // Internal rollback ledger row — opt out of the memory outbox (ADR-0044
        // §42 mirrors the state_snapshot opt-out; a compensation is not a learner
        // fact). Non-NULL stamp = outbox poller's `WHERE ingest_at IS NULL` skips it.
        ingest_at: now,
      });
      compensationEventIds.push(compId);
    }
  });

  return {
    ok: true,
    checkpointEventId,
    reverted: {
      snapshotsRestored,
      structuralRowsArchived,
      eventLayerCompensated,
      totalNodes: effects.length,
    },
    compensationEventIds,
  };
}

// ── internals ────────────────────────────────────────────────────────────────

type EventRow = typeof event.$inferSelect;

/**
 * Apply the imperative inverse for a `structural_imperative` node. Mirrors the
 * established retract dual-write (retractAiProposal). Throws on a missing edge —
 * fail-loud, never a silent no-op.
 */
async function applyImperativeUndo(tx: Tx, undo: ImperativeUndo | undefined): Promise<void> {
  if (!undo) {
    throw new Error('cascade revert: structural_imperative effect missing its imperativeUndo plan');
  }
  if (undo.kind === 'archive_edge') {
    // Single-owner soft-delete. Throws not_found(404) if the edge id is unknown
    // (fail-loud). Idempotent NULL→now guard means a double-revert is safe.
    await archiveKnowledgeEdge(tx, undo.edgeId);
    return;
  }
  // unarchive_edge: the generate ARCHIVED this edge; reverting that re-activates it
  // (archived_at NOT NULL → NULL). Guarded on isNotNull so a re-revert is a no-op.
  await tx
    .update(knowledge_edge)
    .set({ archived_at: null })
    .where(and(eq(knowledge_edge.id, undo.edgeId), isNotNull(knowledge_edge.archived_at)));
}

/** Thrown inside the tx when the in-tx conflict re-check fails (defence-in-depth). */
class CascadeRevertConflictError extends Error {
  constructor(
    public readonly snapshotEventId: string,
    public readonly conflictRef: { kind: 'theta' | 'fsrs'; subjectKind: string; subjectId: string },
  ) {
    super(
      `cascade revert conflict on snapshot ${snapshotEventId} for ` +
        `${conflictRef.subjectKind}/${conflictRef.subjectId} (${conflictRef.kind})`,
    );
    this.name = 'CascadeRevertConflictError';
  }
}

async function loadEventRow(db: DbLike, id: string): Promise<EventRow | null> {
  const rows = await db.select().from(event).where(eq(event.id, id)).limit(1);
  return rows[0] ?? null;
}

async function loadEventRows(db: DbLike, ids: string[]): Promise<Map<string, EventRow>> {
  const map = new Map<string, EventRow>();
  if (ids.length === 0) return map;
  const rows = await db.select().from(event).where(inArray(event.id, ids));
  for (const r of rows) map.set(r.id, r);
  return map;
}

// The validated snapshot payload type (off the inferred schema type).
type StateSnapshotExperimentalPayload = StateSnapshotExperimentalT['payload'];

/** Validate + extract a state_snapshot payload via the parse barrier. */
function parseSnapshotPayload(row: EventRow): StateSnapshotExperimentalPayload {
  const parsed = StateSnapshotExperimental.safeParse({
    actor_kind: row.actor_kind,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome,
    payload: row.payload,
    caused_by_event_id: row.caused_by_event_id ?? undefined,
    task_run_id: row.task_run_id ?? undefined,
    cost_micro_usd: row.cost_micro_usd ?? undefined,
  });
  if (!parsed.success) {
    // A malformed snapshot is unrevertable — fail loud rather than restore garbage.
    throw new Error(
      `cascade revert: state_snapshot ${row.id} failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data.payload;
}

/**
 * Conflict guard: for each snapshot segment, assert the CURRENT live row equals
 * the snapshot's `after`. Returns the first conflicting ref, or null if all match.
 *
 * θ̂ segment: current mastery_state.theta_hat must equal after; if after≠null and
 *   the row is missing, that's a conflict (the after-state should exist). When
 *   after-state had a row (before could be null for cold-start), the row must be
 *   present with theta_hat == after.
 * FSRS segment: current material_fsrs_state.state must deep-equal after (compared
 *   via the FsrsState scalars; jsonb roundtrip-safe).
 */
async function assertSnapshotMatchesCurrent(
  db: DbLike,
  payload: StateSnapshotExperimentalPayload,
): Promise<{ kind: 'theta' | 'fsrs'; subjectKind: string; subjectId: string } | null> {
  for (const snap of payload.theta_snapshots) {
    const rows = await db
      .select({ theta_hat: mastery_state.theta_hat })
      .from(mastery_state)
      .where(
        and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, snap.kc_id)),
      )
      .limit(1);
    const current = rows[0]?.theta_hat;
    // The current θ̂ must equal the snapshot's after. A missing row means the
    // after-state is gone → conflict.
    if (current === undefined || !float4Eq(current, snap.after)) {
      return { kind: 'theta', subjectKind: 'knowledge', subjectId: snap.kc_id };
    }
  }

  for (const snap of payload.fsrs_snapshots) {
    const rows = await db
      .select({ state: material_fsrs_state.state })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, snap.subject_kind),
          eq(material_fsrs_state.subject_id, snap.subject_id),
        ),
      )
      .limit(1);
    const current = rows[0]?.state;
    if (current === undefined || !fsrsCardEq(current, snap.after)) {
      return { kind: 'fsrs', subjectKind: snap.subject_kind, subjectId: snap.subject_id };
    }
  }

  return null;
}

/**
 * float4 (`real`) column compare. HIGH-1: `mastery_state.theta_hat` is a Postgres
 * `real`/float4 (schema.ts:877). The snapshot payload's `after` is the UN-truncated
 * JS double (JSONB stores full precision), but the live column stored only single
 * precision. A bare `current === after` is false for ANY θ̂ that is not float4-exact
 * (0.1, 2/3, real K·credit products) → every warm A-class revert would be a false
 * conflict, and the in-tx re-check would throw + roll back a legitimate revert.
 *
 * Crucially, postgres-js does NOT return `Math.fround(written)` — it parses
 * Postgres's shortest-round-trippable TEXT form of the float4 (e.g. the stored
 * 0.30000001192092896 prints as "0.3", parsed back to the double 0.3). That double
 * is itself NOT fround-equal to the payload double, but BOTH map to the same float4.
 * So compare on the float4 grid by rounding BOTH sides: Math.fround collapses the
 * pretty-printed double and the payload double onto the identical single-precision
 * value. (Empirically verified against the testcontainer: current=0.3,
 * fround(current)===fround(0.1+0.2).)
 */
function float4Eq(current: number, payloadAfter: number): boolean {
  return Math.fround(current) === Math.fround(payloadAfter);
}

/** Compare two FsrsState cards on their scalar identity (jsonb roundtrip-safe). */
function fsrsCardEq(a: FsrsStateSchemaT, b: FsrsStateSchemaT): boolean {
  return (
    +new Date(a.due) === +new Date(b.due) &&
    a.stability === b.stability &&
    a.difficulty === b.difficulty &&
    a.scheduled_days === b.scheduled_days &&
    a.learning_steps === b.learning_steps &&
    a.reps === b.reps &&
    a.lapses === b.lapses &&
    a.state === b.state &&
    sameDateOrNull(a.last_review, b.last_review)
  );
}

function sameDateOrNull(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return +new Date(a) === +new Date(b);
}

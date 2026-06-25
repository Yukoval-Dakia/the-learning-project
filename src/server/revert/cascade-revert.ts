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
// (and the root checkpoint) maps to one class:
//
//   A-class  state_snapshot  — action='experimental:state_snapshot'.
//                              Reversed by restoreStateSnapshot (θ̂ + FSRS row
//                              upsert/delete). Guarded by the conflict check
//                              below (the restore primitive is guard-agnostic by
//                              design — restore-snapshot.ts:16-20).
//
//   B-class  structural fold — generate / rate / propose / archive / suppress /
//                              extract. These drive FOLD projections that read
//                              getCorrectionStatuses; appending a `correct`
//                              (retract) event makes the fold skip them. We do
//                              EVENT-LAYER compensation only (see boundary below).
//
//   IRREVERSIBLE             — real learner facts: attempt / review (FSRS
//                              register) / judge / accept_suggestion
//                              (user_verified) / tool_use. Per 诚实天花板 §100
//                              these cannot be undone (retract = 篡改真实历史).
//
// FAIL-CLOSED: any action NOT in the A/B reversible allowlists is treated as
// IRREVERSIBLE. We never silently skip an unknown node — an unrecognised action
// triggers the same whole-cascade honest-reject as a known-irreversible one
// (so a future event kind can't quietly slip past the revert closure).
//
// ─────────────────────────────────────────────────────────────────────────────
// B-CLASS BOUNDARY (scoped, documented per ADR-0044 §4 + plan):
// This orchestrator does EVENT-LAYER compensation for B-class nodes ONLY: it
// appends a `correct`(retract) event so the FOLD projection skips the node on
// recompute. It does NOT imperatively rebuild / tombstone the pre-SoT-flip
// structural rows (knowledge / knowledge_edge) that are still maintained by the
// imperative write path (proposals/actions.ts). Reasons:
//   - Under the SoT flip (projectionIsWriter()), the edge/node ROW is itself a
//     projection of its events — once the `correct` event lands, re-projecting
//     would drop the row. That path owns its own imperative undo.
//   - Pre-flip, the imperative rows are owned by retractAiProposal-style dual
//     writes; replicating every per-kind imperative undo here would broaden this
//     PR into the fold/SoT-flip lane. That is DEFERRED (see follow-up in header
//     of this file's report + Linear).
// The honest-reject guarantees this boundary is never silently crossed: the
// orchestrator only ever touches A-class state tables + the event log, and the
// `correct` events it writes are the canonical reversal signal the fold honours.
//
// CONFLICT GUARD: before restoring an A-class snapshot, assert the CURRENT state
// row equals snapshot.after. If not (something outside the cascade moved it) →
// 409-style refuse the WHOLE revert. This guard is the orchestrator's job; the
// restore primitive deliberately omits it (restore-snapshot.ts:16-20).
//
// DETERMINISM: single tx, reverse-dependency order (cascade nodes are already
// depth-DESC; the root checkpoint is reverted LAST). Parse-barrier-clean: every
// snapshot payload is validated against StateSnapshotExperimental before use.

import { newId } from '@/core/ids';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import {
  StateSnapshotExperimental,
  type StateSnapshotExperimentalT,
} from '@/core/schema/event/state-snapshot';
import type { Db, Tx } from '@/db/client';
import { event, mastery_state, material_fsrs_state } from '@/db/schema';
import { type CollectCascadeOptions, collectCascadeFromCheckpoint } from '@/server/events/cascade';
import { writeEvent } from '@/server/events/queries';
import { and, eq, inArray } from 'drizzle-orm';
import { restoreStateSnapshot } from './restore-snapshot';

type DbLike = Db | Tx;

/** A-class: the only action whose revert is a state-snapshot restore. */
const STATE_SNAPSHOT_ACTION = 'experimental:state_snapshot';

/**
 * B-class structural-fold actions. Reversed by an event-layer `correct` event so
 * the fold projection (getCorrectionStatuses) skips them. FAIL-CLOSED: anything
 * outside this set (and the A-class action) is treated as irreversible.
 */
const STRUCTURAL_FOLD_ACTIONS: ReadonlySet<string> = new Set([
  'generate',
  'rate',
  'propose',
  'archive',
  'suppress',
  'extract',
  // Checkpoint ANCHOR actions (the root of a per-utterance revert). A copilot
  // user-ask / chip-trigger is a reversible utterance marker (诚实天花板 §102:
  // turn 内刚说完未练 几乎总干净 / 题进 frontier 可撤). It carries no A-class
  // state mutation — event-layer compensation (a `correct` retract) is the whole
  // reversal: re-collection from this checkpoint then sees the retract and skips.
  // NOT a real learner fact (those are attempt/review/judge — see IRREVERSIBLE).
  'experimental:copilot_user_ask',
  'experimental:copilot_chip_trigger',
]);

/** The compensation actor (agent lane; non-'self' per CorrectEvent attribution). */
const CASCADE_REVERT_ACTOR_REF = 'cascade_revert';

export type ReversibilityClass = 'state_snapshot' | 'structural_fold' | 'irreversible';

export interface RevertableEffect {
  eventId: string;
  action: string;
  reversibility: ReversibilityClass;
}

export interface CascadeRevertResult {
  ok: true;
  checkpointEventId: string;
  reverted: {
    /** A-class state_snapshot events restored. */
    snapshotsRestored: number;
    /** B-class structural-fold events compensated with a `correct` event. */
    foldsCompensated: number;
    /** Total nodes reverted (snapshots + folds + root if reversible). */
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

/** Classify a single event action into its reversibility class (fail-closed). */
function classifyAction(action: string): ReversibilityClass {
  if (action === STATE_SNAPSHOT_ACTION) return 'state_snapshot';
  if (STRUCTURAL_FOLD_ACTIONS.has(action)) return 'structural_fold';
  return 'irreversible';
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

  // 4. PRE-CHECK reversibility (all-or-nothing). Any irreversible / unknown node
  //    → refuse the whole revert naming what blocked it.
  const effects: RevertableEffect[] = orderedRows.map((r) => ({
    eventId: r.id,
    action: r.action,
    reversibility: classifyAction(r.action),
  }));
  const irreversible = effects.filter((e) => e.reversibility === 'irreversible');
  if (irreversible.length > 0) {
    const actionsList = irreversible.map((e) => `${e.action}(${e.eventId})`).join(', ');
    return {
      ok: false,
      refusal: 'irreversible',
      reason: `cascade from ${checkpointEventId} contains ${irreversible.length} irreversible node(s) (real attempt/review/judge/accept_suggestion/tool_use, or an unrecognised action — fail-closed). Per 诚实天花板 a real learner fact cannot be reverted; refusing the whole cascade rather than a partial one. Irreversible actions: ${actionsList}`,
      irreversibleEventIds: irreversible.map((e) => e.eventId),
    };
  }

  // 5. PRE-CHECK the A-class conflict guard for EVERY snapshot BEFORE opening the
  //    tx, so a conflict refuses without any mutation. Parse + validate each
  //    snapshot payload here too (parse-barrier).
  const snapshotPayloads = new Map<string, StateSnapshotExperimentalPayload>();
  for (const r of orderedRows) {
    if (classifyAction(r.action) !== 'state_snapshot') continue;
    const payload = parseSnapshotPayload(r);
    snapshotPayloads.set(r.id, payload);
    const conflict = await assertSnapshotMatchesCurrent(db, payload);
    if (conflict) {
      return {
        ok: false,
        refusal: 'conflict',
        reason: `state_snapshot ${r.id} conflict: current ${conflict.kind} state for ${conflict.subjectKind}/${conflict.subjectId} != snapshot.after — something outside the cascade modified it. Refusing the whole revert.`,
        conflictRef: conflict,
      };
    }
  }

  // 6. Execute inside ONE tx: reverse-dependency order (orderedRows already
  //    deepest-first, root last). Each reversible node gets its effect applied +
  //    a `correct` compensation event so re-collection won't re-sweep it.
  const compensationEventIds: string[] = [];
  let snapshotsRestored = 0;
  let foldsCompensated = 0;
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const r of orderedRows) {
      const cls = classifyAction(r.action);
      if (cls === 'state_snapshot') {
        const payload = snapshotPayloads.get(r.id);
        if (!payload) {
          // Defensive: every snapshot was parsed in step 5.
          throw new Error(`snapshot payload for ${r.id} missing in apply phase`);
        }
        // Re-assert the conflict guard inside the tx (defence-in-depth against a
        // concurrent writer between pre-check and tx). A conflict here throws to
        // roll back the whole tx — the pre-check already returned the typed
        // refusal in the common case.
        const conflict = await assertSnapshotMatchesCurrent(tx, payload);
        if (conflict) {
          throw new CascadeRevertConflictError(r.id, conflict);
        }
        await restoreStateSnapshot(tx, payload);
        snapshotsRestored += 1;
      } else {
        // structural_fold → event-layer compensation only (see B-class boundary).
        foldsCompensated += 1;
      }

      // Write the compensation `correct`(retract) event for EVERY reverted node
      // (A-class + B-class) so a re-collection skips it (cascade.ts drops
      // action='correct' children + the getCorrectionStatuses fold honours it).
      const compId = newId();
      await writeEvent(tx, {
        id: compId,
        actor_kind: 'agent',
        actor_ref: CASCADE_REVERT_ACTOR_REF,
        action: 'correct',
        subject_kind: 'event',
        subject_id: r.id,
        outcome: 'success',
        payload: {
          correction_kind: 'retract',
          reason_md: `cascade revert of checkpoint ${checkpointEventId} (${cls})`,
          affected_refs: [{ kind: 'open_inquiry', id: r.id }],
        },
        caused_by_event_id: r.id,
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
      foldsCompensated,
      totalNodes: orderedRows.length,
    },
    compensationEventIds,
  };
}

// ── internals ────────────────────────────────────────────────────────────────

type EventRow = typeof event.$inferSelect;

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
    // after-state is gone → conflict (real type is `real`, exact compare is safe
    // because `after` was itself written as a `real`).
    if (current === undefined || !floatEq(current, snap.after)) {
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

/** `real` column compare — exact equality (the after-value was stored as real). */
function floatEq(a: number, b: number): boolean {
  return a === b;
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

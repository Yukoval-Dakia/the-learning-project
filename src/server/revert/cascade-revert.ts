// One cascade revert. The class depends on action, subject_kind, and edge_op.
// Anything outside the reversible tables is irreversible, and one such node refuses the whole cascade.
// state_snapshot restore does not check the live row. This orchestrator does.
// θ̂ uses exact ===. FSRS uses fsrsCardEq on the card scalars.
// The root checkpoint is applied last, in one transaction.

import { and, eq, inArray } from 'drizzle-orm';
import { archiveKnowledgeEdgeFromEvents } from '@/capabilities/knowledge/public';
import { newId } from '@/core/ids';
import { stableStringify } from '@/core/migration/canonical';
import {
  StateSnapshotExperimental,
  type StateSnapshotExperimentalT,
} from '@/core/schema/event/state-snapshot';
import {
  type SchedulingState,
  SchedulingStateSchema,
  isCandidateState,
} from '@/core/schema/scheduling-state';
import type { Db, Tx } from '@/db/client';
import {
  acquireLearningStateWriteLock,
  acquireSortedAdvisoryLocks,
} from '@/db/learning-state-lock';
import { event, mastery_state, material_fsrs_state } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { type CollectCascadeOptions, collectCascadeFromCheckpoint } from '@/server/events/cascade';
import { restoreStateSnapshot } from './restore-snapshot';

type DbLike = Db | Tx;

/** A-class: the only action whose revert is a state-snapshot restore. */
const STATE_SNAPSHOT_ACTION = 'experimental:state_snapshot';

/** Shared with the revert endpoint so the two sides do not mint a second copy of these action names. */
export const COPILOT_USER_ASK_ACTION = 'experimental:copilot_user_ask';
export const COPILOT_REPLY_ACTION = 'experimental:copilot_reply';

/**
 * A `correct` retract is the whole reversal. These actions have no separate live row.
 * An ask checkpoint's reply is in the cascade. Leaving this action out refuses that revert.
 * propose is the suggestion. Its materialization is a separate generate.
 * rate stays here, but classifyRow refuses rating accept before this lookup.
 * tool_use is the tool-call mirror. The tool's effect is a separate event in the cascade.
 * grading_checkpoint only anchors a state_snapshot. The state lives in that snapshot.
 */
const EVENT_LAYER_ACTIONS: ReadonlySet<string> = new Set([
  COPILOT_REPLY_ACTION,
  'experimental:teach_message',
  COPILOT_USER_ASK_ACTION,
  'experimental:copilot_chip_trigger',
  'experimental:grading_checkpoint',
  'propose',
  'rate',
  'tool_use',
]);

/** CorrectEvent attribution rejects actor_ref 'self' for an agent actor. */
const CASCADE_REVERT_ACTOR_REF = 'cascade_revert';

export type ReversibilityClass =
  | 'state_snapshot'
  | 'structural_imperative'
  | 'event_layer'
  | 'irreversible';

/**
 * The only wired inverse is archiving the edge a create-generate produced.
 * There is no unarchive. The fold's only path back to a live row is a fresh create, which replaces created_at and created_by.
 */
export type ImperativeUndo = { kind: 'archive_edge'; edgeId: string };

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
    snapshotsRestored: number;
    /** Edges archived. There is no unarchive. */
    structuralRowsArchived: number;
    /** Nodes whose `correct` retract is the whole reversal. */
    eventLayerCompensated: number;
    /** Every reverted node, including the ones counted above. Each one gets a `correct` event. */
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
      // The checkpoint row is missing. This attempt was never bracketed. It is not a learner fact in the closure.
      ok: false;
      refusal: 'no_checkpoint';
      reason: string;
    }
  | {
      ok: false;
      refusal: 'irreversible';
      reason: string;
      /** Event ids that are irreversible, including shapes this module does not know. */
      irreversibleEventIds: string[];
    }
  | {
      // The snapshot's θ̂ before is a bare number, so restore refused instead of inventing the other columns.
      ok: false;
      refusal: 'legacy_snapshot';
      reason: string;
      ref: { kind: 'theta'; kcId: string };
    }
  | {
      ok: false;
      refusal: 'conflict';
      reason: string;
      conflictRef: { kind: 'theta' | 'fsrs'; subjectKind: string; subjectId: string };
    };

export type OrchestrateCascadeRevertResult = CascadeRevertResult | CascadeRevertRefusal;

export interface OrchestrateCascadeRevertOptions extends CollectCascadeOptions {
  copilotAskOnly?: boolean;
  /**
   * Written onto each retract's reason_md. There is no segment slicer.
   * The caller picks the checkpoint, and that checkpoint closes over one segment.
   */
  reasonContext?: { appeal_event_id?: string; note?: string };
}

/** Fail closed. A generate's class depends on subject_kind and edge_op, not on the action alone. */
function classifyRow(row: EventRow): RevertableEffect {
  const base = { eventId: row.id, action: row.action };

  if (row.action === STATE_SNAPSHOT_ACTION) {
    return { ...base, reversibility: 'state_snapshot' };
  }

  // subject_id is the edge id.
  // A `correct` event is keyed as an event, so the edge fold never sees it. A rebuild would resurrect the create unless this also writes a fold-visible archive.
  // An archive generate stays irreversible. A fresh create would replace created_at and created_by.
  if (row.action === 'generate' && row.subject_kind === 'knowledge_edge') {
    const edgeOp = (row.payload as { edge_op?: string } | null)?.edge_op;
    if (edgeOp === 'archive') {
      return { ...base, reversibility: 'irreversible' };
    }
    return {
      ...base,
      reversibility: 'structural_imperative',
      imperativeUndo: { kind: 'archive_edge', edgeId: row.subject_id },
    };
  }

  // An accepted vote landed a knowledge mutation outside this chain. Retracting the vote would leave that mutation in place.
  // dismiss, rollback, and a plain vote stay reversible below.
  if (row.action === 'rate' && (row.payload as { rating?: string } | null)?.rating === 'accept') {
    return { ...base, reversibility: 'irreversible' };
  }

  if (EVENT_LAYER_ACTIONS.has(row.action)) {
    return { ...base, reversibility: 'event_layer' };
  }

  // Fallback. Everything not listed in a reversible table is irreversible.
  // extract and suppress are their own actions.
  // They land here because no reversible table names them.
  // A generate whose subject is not a knowledge edge lands here for the same reason.
  return { ...base, reversibility: 'irreversible' };
}

/**
 * Must stay inside classifyRow's reversible set for an ask. A wider list is still refused. A narrower list refuses a turn that can be reverted.
 * teach_message, chip_trigger, and grading_checkpoint belong to other lanes, so they stay out.
 * An absent edge_op is a create. Refusing only archive also keeps supersede.
 */
export function copilotAskRevertAllows(row: EventRow, isRoot: boolean): boolean {
  // runQuestionAuthor inserts the draft question in the same transaction as the proposal. That row is outside this chain.
  // The action is already excluded. This marker still refuses it, so a later action change cannot tombstone the turn and leave the draft.
  const proposalKind = (row.payload as { ai_proposal?: { kind?: string } } | null)?.ai_proposal
    ?.kind;
  if (proposalKind === 'question_draft') return false;

  // Same refusal as classifyRow. An accept leaves a mutation this chain cannot retract.
  if (row.action === 'rate' && (row.payload as { rating?: string } | null)?.rating === 'accept') {
    return false;
  }

  return (
    (isRoot && row.action === COPILOT_USER_ASK_ACTION) ||
    row.action === COPILOT_REPLY_ACTION ||
    row.action === STATE_SNAPSHOT_ACTION ||
    row.action === 'propose' ||
    row.action === 'rate' ||
    // Without this, an ask that only mirrored the tool call is refused.
    row.action === 'tool_use' ||
    (row.action === 'generate' &&
      row.subject_kind === 'knowledge_edge' &&
      (row.payload as { edge_op?: string } | null)?.edge_op !== 'archive')
  );
}

/**
 * Refuse the whole cascade on truncation, an irreversible node, or a conflict. Otherwise apply it in one transaction, deepest node first.
 */
export async function orchestrateCascadeRevert(
  db: DbLike,
  checkpointEventId: string,
  opts?: OrchestrateCascadeRevertOptions,
): Promise<OrchestrateCascadeRevertResult> {
  // A caller transaction makes db.transaction a savepoint. A conflict then rolls back only the apply, and the caller can still commit its own marker.
  // A top-level Db opens a real transaction below.
  // Row locks must not precede the learning-state lock, or this transaction deadlocks a writer that takes that lock first.
  // A Tx has no $client, so the lock is taken here, before any row read. A Db skips it. Its pre-check locks end with each statement, and the real transaction takes the lock first.
  if (!('$client' in db)) {
    await acquireLearningStateWriteLock(db);
  }

  // A truncated closure is refused. A partial set is never applied.
  const cascade = await collectCascadeFromCheckpoint(db, checkpointEventId, opts);
  if (cascade.truncated) {
    return {
      ok: false,
      refusal: 'truncated',
      reason: `cascade from ${checkpointEventId} exceeds the depth/node limit — refusing the whole revert (a partial cascade is never applied; manual intervention required)`,
    };
  }

  // The collector omits the root. It is appended below and applied last.
  const rootRow = await loadEventRow(db, checkpointEventId);
  if (!rootRow) {
    // Missing is not irreversible. irreversible is a learner fact inside the closure.
    return {
      ok: false,
      refusal: 'no_checkpoint',
      reason: `checkpoint event ${checkpointEventId} not found — no snapshot bracket for this segment/attempt (nothing to revert; the caller should defer to full reprojection)`,
    };
  }

  // The collector returns deepest first. The root cannot already be in that list.
  const orderedRows: EventRow[] = [];
  const nodeRows = await loadEventRows(
    db,
    cascade.nodes.map((n) => n.id),
  );
  for (const node of cascade.nodes) {
    const row = nodeRows.get(node.id);
    if (!row) {
      // Skipping a vanished node would revert the rest and report success.
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

  // One irreversible node refuses the cascade before any write.
  const effects: RevertableEffect[] = orderedRows.map(classifyRow);
  if (opts?.copilotAskOnly) {
    for (let index = 0; index < orderedRows.length; index += 1) {
      const row = orderedRows[index];
      if (!copilotAskRevertAllows(row, row.id === checkpointEventId))
        effects[index] = { eventId: row.id, action: row.action, reversibility: 'irreversible' };
    }
  }
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

  // A conflict returns before the transaction, so nothing is written. The payload is parsed here, not inside the apply.
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

  // A typed conflict or legacy error rolls back only this transaction and returns a refusal. Any other throw still propagates.
  const compensationEventIds: string[] = [];
  let snapshotsRestored = 0;
  let structuralRowsArchived = 0;
  let eventLayerCompensated = 0;
  const now = new Date();

  // Empty when the caller passed no provenance.
  const rc = opts?.reasonContext;
  const reasonSuffix = rc
    ? ` — appeal:${rc.appeal_event_id ?? '?'}${rc.note ? ` (${rc.note})` : ''}`
    : '';

  try {
    await db.transaction(async (tx) => {
      await acquireLearningStateWriteLock(tx);
      await acquireSnapshotStateLocks(tx, snapshotPayloads.values());
      for (const e of effects) {
        if (e.reversibility === 'state_snapshot') {
          const payload = snapshotPayloads.get(e.eventId);
          if (!payload) {
            // Every snapshot was parsed before this transaction. A miss here is a bug, not a skip.
            throw new Error(`snapshot payload for ${e.eventId} missing in apply phase`);
          }
          // The pre-check can go stale before this transaction. A conflict here throws, and the catch returns the refusal.
          const conflict = await assertSnapshotMatchesCurrent(tx, payload, true);
          if (conflict) {
            throw new CascadeRevertConflictError(e.eventId, conflict);
          }
          // A bare-number before must become a refusal. Returning it directly would not roll back the rows already restored in this transaction.
          const restored = await restoreStateSnapshot(tx, payload);
          if (!restored.ok) {
            throw new CascadeRevertLegacyError(e.eventId, restored.ref);
          }
          snapshotsRestored += 1;
        } else if (e.reversibility === 'structural_imperative') {
          // The edge fold ignores the `correct` event below. This archive is what a rebuild reads. The shared `now` keeps the row and the fold on one timestamp.
          await applyImperativeUndo(tx, e.imperativeUndo, e.eventId, now);
          structuralRowsArchived += 1;
        } else {
          eventLayerCompensated += 1;
        }

        // The collector drops action `correct`, so this retract is not collected again. The original snapshot still is.
        // A second revert stops because the live row is now `before`, not `after`. Restoring `before` is only right for the latest transition.
        // The edge fold ignores this retract. Projections that read corrections still see it.
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
            reason_md: `cascade revert of checkpoint ${checkpointEventId} (${e.reversibility})${reasonSuffix}`,
            affected_refs: [{ kind: 'open_inquiry', id: e.eventId }],
          },
          caused_by_event_id: e.eventId,
          created_at: now,
          // A compensation is not a learner fact. A non-null ingest_at is skipped by the outbox poller.
          ingest_at: now,
        });
        compensationEventIds.push(compId);
      }
    });
  } catch (err) {
    // These two errors are already rolled back. Return them so the caller can commit its own marker. Anything else is a fault.
    if (err instanceof CascadeRevertConflictError) {
      return {
        ok: false,
        refusal: 'conflict',
        reason: `state_snapshot ${err.snapshotEventId} conflict (in-tx re-check): current ${err.conflictRef.kind} state for ${err.conflictRef.subjectKind}/${err.conflictRef.subjectId} != snapshot.after — refusing the whole revert.`,
        conflictRef: err.conflictRef,
      };
    }
    if (err instanceof CascadeRevertLegacyError) {
      return {
        ok: false,
        refusal: 'legacy_snapshot',
        reason: `state_snapshot ${err.snapshotEventId} has a legacy bare-number θ̂ before for ${err.ref.kcId} — unrevertable (pre-S1 snapshot). Refusing (defer to full reprojection).`,
        ref: err.ref,
      };
    }
    throw err;
  }

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

type EventRow = typeof event.$inferSelect;

/**
 * Knowledge owns the archive write. Missing history or a concurrent archive aborts the cascade.
 * The cause, timestamp, and outbox opt-out stay on that write.
 */
async function applyImperativeUndo(
  tx: Tx,
  undo: ImperativeUndo | undefined,
  revertedGenerateEventId: string,
  now: Date,
): Promise<void> {
  if (!undo) {
    throw new Error('cascade revert: structural_imperative effect missing its imperativeUndo plan');
  }
  const { edgeId } = undo;

  const archived = await archiveKnowledgeEdgeFromEvents(tx, edgeId, {
    caused_by_event_id: revertedGenerateEventId,
    created_at: now,
    // Same outbox opt-out as the compensation event. The archive generate is not a learner fact either.
    ingest_at: now,
  });
  if (!archived.archived) {
    throw new Error(`cascade revert: knowledge_edge ${edgeId} changed before archive`);
  }
}

/** Thrown so the catch can return a refusal after this transaction rolls back. */
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

/** Thrown so a bare-number before becomes a refusal instead of a partial write. */
class CascadeRevertLegacyError extends Error {
  constructor(
    public readonly snapshotEventId: string,
    public readonly ref: { kind: 'theta'; kcId: string },
  ) {
    super(
      `cascade revert: legacy bare-number θ̂ before on snapshot ${snapshotEventId} (${ref.kcId})`,
    );
    this.name = 'CascadeRevertLegacyError';
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

type StateSnapshotExperimentalPayload = StateSnapshotExperimentalT['payload'];

/** Throw on an invalid payload. Restoring it would write a guessed row. */
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
    throw new Error(
      `cascade revert: state_snapshot ${row.id} failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data.payload;
}

async function acquireSnapshotStateLocks(
  tx: Tx,
  payloads: Iterable<StateSnapshotExperimentalPayload>,
): Promise<void> {
  // The learning-state lock is what writers take. These locks only cover the conflict guard's row reads.
  // ability_global is taken after fsrs, in the same order as the writer. Reversing the two deadlocks.
  const fsrsIds = new Set<string>();
  const globalIds = new Set<string>();
  for (const payload of payloads) {
    for (const snap of payload.theta_snapshots) {
      if (snap.subject_kind === 'ability_global') {
        globalIds.add(snap.kc_id);
      } else {
        fsrsIds.add(`knowledge:${snap.kc_id}`);
      }
    }
    for (const snap of payload.fsrs_snapshots) {
      fsrsIds.add(`${snap.subject_kind}:${snap.subject_id}`);
    }
  }
  await acquireSortedAdvisoryLocks(tx, 'fsrs', [...fsrsIds]);
  await acquireSortedAdvisoryLocks(tx, 'mastery:ability_global', [...globalIds]);
}

/** Return the first segment whose live row is missing or differs from after. A missing row means the after state is gone. */
async function assertSnapshotMatchesCurrent(
  db: DbLike,
  payload: StateSnapshotExperimentalPayload,
  lockRows = false,
): Promise<{ kind: 'theta' | 'fsrs'; subjectKind: string; subjectId: string } | null> {
  for (const snap of payload.theta_snapshots) {
    // A payload written before subject_kind existed is a per-KC row.
    const subjectKind = snap.subject_kind ?? 'knowledge';
    const rows = await db
      .select({ theta_hat: mastery_state.theta_hat })
      .from(mastery_state)
      .where(
        and(eq(mastery_state.subject_kind, subjectKind), eq(mastery_state.subject_id, snap.kc_id)),
      )
      .limit(1)
      .for(lockRows ? 'update' : 'no key update');
    const current = rows[0]?.theta_hat;
    if (current === undefined || !thetaExactEq(current, snap.after)) {
      return { kind: 'theta', subjectKind, subjectId: snap.kc_id };
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
      .limit(1)
      .for(lockRows ? 'update' : 'no key update');
    const current = rows[0]?.state;
    if (current === undefined || !fsrsCardEq(current, snap.after)) {
      return { kind: 'fsrs', subjectKind: snap.subject_kind, subjectId: snap.subject_id };
    }
  }

  return null;
}

/**
 * theta_hat is double precision. The live column and snapshot.after come from the same
 * computation, and postgres-js round-trips that float without loss, so === does not false-alarm.
 * Rounding both sides would hide a real drift.
 */
function thetaExactEq(current: number, payloadAfter: number): boolean {
  return current === payloadAfter;
}

/** A candidate is not a card, so it is compared whole. A card is compared on its scalars, so a jsonb date round-trip still matches. */
function fsrsCardEq(rawA: SchedulingState, rawB: SchedulingState): boolean {
  const a = SchedulingStateSchema.parse(rawA);
  const b = SchedulingStateSchema.parse(rawB);
  if (isCandidateState(a) || isCandidateState(b)) return stableStringify(a) === stableStringify(b);
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

// Per-tick orphan execution, kept out of the admin CLI's import graph so the static Copilot
// import cannot initialize the DB before the CLI's loadEnv. Loading Copilot at module
// evaluation keeps the selection-lock wait from trailing a cold module load.
import {
  ConversationOrphanStateError,
  abandonOrphanConversationTx,
} from '@/capabilities/copilot/public';
import type { Db } from '@/db/client';
import { session_orphan_receipt } from '@/db/schema';
import { readContractEpoch, waitForRunnableEpoch } from '@/server/migration/contract-epoch/epoch';
import {
  ContractEpochFenceError,
  gateContractEpoch,
} from '@/server/migration/contract-epoch/rules';
import {
  type Counts,
  type SessionOrphanBoundaryHook,
  SessionOrphanContractError,
  type SessionOrphanOutcome,
  type SessionOrphanRequest,
  type SessionOrphanSummary,
  type SessionOrphanTick,
  SessionOrphanUnknownOutcome,
  admitTick,
  inspectSessionOrphanAdmission,
  inspectSessionOrphanOutcome,
  lockSessionOrphanControl,
  lockSessionOrphanTick,
  parseSessionOrphan,
  readSessionOrphanReceipt,
  readSessionOrphanTick,
  rejectSessionOrphanDisposition,
  requireMember,
  sessionOrphanKey,
  sessionOrphanOutcomeSchema,
  sessionOrphanRequestSchema,
  validateIdentity,
} from './session-orphan-family';

async function commitRow(
  db: Db,
  request: SessionOrphanRequest,
  sessionId: string,
  deferred?: string,
): Promise<SessionOrphanOutcome> {
  const key = sessionOrphanKey(request);
  const placementLifecycle =
    !deferred && request.family === 'prune_orphan_placement_sessions'
      ? await import('@/capabilities/practice/public')
      : null;
  return db.transaction(
    async (tx) => {
      const phase = await lockSessionOrphanControl(tx, key.family);
      await lockSessionOrphanTick(tx, key);
      const saved = await readSessionOrphanTick(tx, key);
      if (!saved) throw new SessionOrphanContractError('Frozen tick missing');
      await validateIdentity(tx, saved, request);
      requireMember(saved, sessionId);
      const prior = await readSessionOrphanReceipt(tx, key, sessionId);
      if (prior) return prior;
      const authorized =
        saved.backend === 'dbos'
          ? phase === 'dbos' || phase === 'draining-dbos'
          : phase === 'pg-boss' || phase === 'draining-pg-boss';
      if (saved.admission !== 'admitted' || !authorized)
        throw new SessionOrphanContractError(`Admitted tick cannot execute in ${phase}`);
      await rejectSessionOrphanDisposition(tx, key, sessionId);
      let outcome: SessionOrphanOutcome;
      if (deferred) outcome = { kind: 'deferred-known-failure', error: deferred };
      else {
        try {
          switch (request.family) {
            case 'prune_orphan_conversation_sessions':
              outcome = await abandonOrphanConversationTx(tx, { sessionId, cutoff: saved.cutoff });
              break;
            case 'prune_orphan_placement_sessions':
              outcome = await placementLifecycle!.abandonOrphanPlacementTx(tx, {
                sessionId,
                cutoff: saved.cutoff,
              });
              break;
            default: {
              const exhaustive: never = request.family;
              throw new SessionOrphanContractError(String(exhaustive));
            }
          }
        } catch (error) {
          if (
            error instanceof ConversationOrphanStateError ||
            (placementLifecycle !== null &&
              error instanceof placementLifecycle.PlacementOrphanStateError)
          )
            throw new SessionOrphanContractError(error.message, { cause: error });
          throw error;
        }
      }
      parseSessionOrphan(sessionOrphanOutcomeSchema, outcome);
      await tx
        .insert(session_orphan_receipt)
        .values({ family: key.family, tick_id: key.tickId, session_id: sessionId, outcome });
      return outcome;
    },
    { isolationLevel: 'read committed' },
  );
}
async function gateTickEpoch(db: Db, request: SessionOrphanRequest): Promise<void> {
  if (request.source.kind === 'dbos') return waitForRunnableEpoch(db);
  const verdict = gateContractEpoch(await readContractEpoch(db));
  if (!verdict.runnable && verdict.reason !== 'epoch_mismatch')
    throw new ContractEpochFenceError(`job:${request.family}`, verdict);
}
export async function runSessionOrphanTick(
  db: Db,
  raw: SessionOrphanRequest,
  boundary: SessionOrphanBoundaryHook = async () => {},
): Promise<SessionOrphanSummary> {
  const request = parseSessionOrphan(sessionOrphanRequestSchema, raw);
  const key = sessionOrphanKey(request);
  await gateTickEpoch(db, request);
  let saved: SessionOrphanTick;
  try {
    saved = await admitTick(db, request);
  } catch (error) {
    if (error instanceof SessionOrphanContractError) throw error;
    const inspected = await inspectSessionOrphanAdmission(db, request);
    if (inspected.kind === 'unknown')
      throw new SessionOrphanUnknownOutcome(key.family, key.tickId, null, error);
    if (inspected.kind === 'committed') saved = inspected.tick;
    else {
      try {
        saved = await admitTick(db, request);
      } catch (admissionError) {
        if (admissionError instanceof SessionOrphanContractError) throw admissionError;
        const second = await inspectSessionOrphanAdmission(db, request);
        if (second.kind !== 'committed')
          throw new SessionOrphanUnknownOutcome(key.family, key.tickId, null, admissionError);
        saved = second.tick;
      }
    }
  }
  await boundary({ ...key, kind: 'selection-committed' });
  if (saved.admission === 'fenced')
    return { ...key, kind: 'fenced', candidates: 0, abandoned: 0, skipped: 0, deferred: 0 };
  const counts: Counts = {
    ...key,
    candidates: saved.candidates.length,
    abandoned: 0,
    skipped: 0,
    deferred: 0,
  };
  for (const candidate of saved.candidates) {
    await gateTickEpoch(db, request);
    let outcome: SessionOrphanOutcome;
    try {
      outcome = await commitRow(db, request, candidate.sessionId);
    } catch (error) {
      if (error instanceof SessionOrphanContractError) throw error;
      const inspected = await inspectSessionOrphanOutcome(db, {
        ...key,
        sessionId: candidate.sessionId,
      });
      if (inspected.kind === 'unknown')
        throw new SessionOrphanUnknownOutcome(key.family, key.tickId, candidate.sessionId, error);
      if (inspected.kind === 'committed') outcome = inspected.outcome;
      else {
        try {
          outcome = await commitRow(db, request, candidate.sessionId, String(error));
        } catch (receiptError) {
          if (receiptError instanceof SessionOrphanContractError) throw receiptError;
          const receipt = await inspectSessionOrphanOutcome(db, {
            ...key,
            sessionId: candidate.sessionId,
          });
          if (receipt.kind !== 'committed')
            throw new SessionOrphanUnknownOutcome(
              key.family,
              key.tickId,
              candidate.sessionId,
              receiptError,
            );
          outcome = receipt.outcome;
        }
      }
    }
    if (outcome.kind === 'abandoned') counts.abandoned++;
    else if (outcome.kind === 'skipped') counts.skipped++;
    else counts.deferred++;
    // Boundary failures are process failures, never ordinary row failures.
    await boundary({ ...key, kind: 'row-committed', sessionId: candidate.sessionId });
  }
  return counts.deferred
    ? { ...counts, kind: 'completed-with-deferred' }
    : { ...counts, kind: 'complete', deferred: 0 };
}

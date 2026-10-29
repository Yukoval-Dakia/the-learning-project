import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { learning_session, memory_brief_note, source_document } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  PURPOSE_BRIEF_LOCK,
  PURPOSE_CHANGE_ACTION,
  PurposeChangeInput,
  PurposeChangeReceipt,
  type PurposeChangeReceiptT,
  purposeOperationId,
  readAdmissionPurposeImpact,
  readPurposeReceipt,
  readPurposeRepairs,
} from '@/kernel/read-models/purpose-change';
import {
  documentUsageEpoch,
  readDocumentDerivationPolicy,
} from '@/kernel/read-models/usage-policy';
import {
  AGENT_BUDGET_LOCK_KEY,
  parseAgentBudget,
  writeAgentBudgetPath,
} from './agent/budget-state';

/** Complete private owner. The API never updates provenance or reconstructs a receipt. */
export async function changeIngestionPurpose(db: Db, sessionId: string, raw: unknown) {
  const input = PurposeChangeInput.parse(raw);
  const operationId = purposeOperationId(sessionId, input.request_id);
  const result = await db.transaction(async (tx) => {
    // A document may bind several sessions. Match the existing global->sessions
    // budget order so its cross-session settlement cannot deadlock this command.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${AGENT_BUDGET_LOCK_KEY}))`);
    // Lock all sessions bound to this source in stable order, then the document.
    const sessions = await tx
      .select()
      .from(learning_session)
      .where(
        and(
          eq(learning_session.type, 'ingestion'),
          sql`(${learning_session.id} = ${sessionId} OR ${learning_session.source_document_id} = ${input.source_document_id})`,
        ),
      )
      .orderBy(learning_session.id)
      .for('update');
    const session = sessions.find((row) => row.id === sessionId);
    if (!session) throw new ApiError('not_found', 'ingestion session not found', 404);
    const prior = await readPurposeReceipt(tx, operationId);
    if (prior) {
      if (sha256CanonicalJson(prior.input) !== sha256CanonicalJson(input))
        throw new ApiError(
          'purpose_request_conflict',
          'request identity is bound to different input',
          409,
        );
      return { receipt: prior, replayed: true };
    }
    if (session.source_document_id !== input.source_document_id)
      throw new ApiError('purpose_source_conflict', 'source document changed', 409);
    const [doc] = await tx
      .select()
      .from(source_document)
      .where(eq(source_document.id, input.source_document_id))
      .for('update');
    if (!doc) throw new ApiError('not_found', 'source document not found', 404);
    if (doc.version !== input.expected_version)
      throw new ApiError('purpose_version_conflict', 'refresh the source document version', 409);
    const policy = readDocumentDerivationPolicy(doc.provenance);
    const rawPolicy = (doc.provenance as Record<string, unknown>).usage_policy;
    // Missing legacy policy is valid; malformed explicit policy and system crisis
    // cannot be turned into a new permissive authorization by this user command.
    if (
      policy === 'crisis' ||
      (rawPolicy !== undefined &&
        (typeof rawPolicy !== 'object' ||
          rawPolicy === null ||
          !['allow', 'answer_only'].includes(
            String((rawPolicy as Record<string, unknown>).derivation_policy),
          )))
    )
      throw new ApiError(
        'purpose_system_restriction',
        'system or invalid policy requires its own owner',
        422,
      );
    const changed = policy !== input.target;
    const cleanupRequired = input.target === 'answer_only';
    const epoch = changed ? operationId : documentUsageEpoch(doc.provenance);
    const stopped: PurposeChangeReceiptT['stop'] = [];
    if (cleanupRequired) {
      for (const bound of sessions.filter((row) => row.source_document_id === doc.id)) {
        const budget = parseAgentBudget(bound.agent_budget);
        const owner = budget?.execution_owner;
        if (owner?.state === 'active') {
          await writeAgentBudgetPath(tx, bound.id, ['execution_owner'], {
            ...owner,
            stop_request_id: operationId,
          });
          stopped.push({
            session_id: bound.id,
            run_ref: owner.run_ref,
            operation_id: owner.operation_id,
          });
        } else if (
          ['queued', 'extracting'].includes(bound.status) ||
          Object.keys(budget?.unproven_dispatches ?? {}).length
        ) {
          stopped.push({ session_id: bound.id, run_ref: null, operation_id: null });
        }
      }
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${PURPOSE_BRIEF_LOCK}, 0))`);
    // Facts used by legacy briefs were not recorded as evidence ids. Every existing
    // scope is conservatively affected; never infer absence from the visible ids.
    const scopes = cleanupRequired
      ? await tx
          .select({ scope_key: memory_brief_note.scope_key, version: memory_brief_note.version })
          .from(memory_brief_note)
      : [];
    const receipt = PurposeChangeReceipt.parse({
      version: 1,
      input,
      session_id: sessionId,
      operation_id: operationId,
      policy_committed: true,
      previous_policy: policy,
      committed_version: doc.version + 1,
      changed,
      epoch,
      stop: stopped,
      brief_scopes: scopes,
      cleanup_required: cleanupRequired,
      admission_obligation: cleanupRequired
        ? {
            state: 'pending',
            effect: 'unknown',
            reason: 'source_fence_active_history_unknown',
            source_document_id: doc.id,
          }
        : null,
      external_effect: 'unknown_or_irreversible',
      derivation_policy: 'answer_only',
    });
    await tx
      .update(source_document)
      .set({
        provenance: {
          ...doc.provenance,
          usage_policy: {
            ...(rawPolicy as Record<string, unknown> | undefined),
            derivation_policy: input.target,
          },
          usage_epoch: epoch,
        },
        version: doc.version + 1,
        updated_at: new Date(),
      })
      .where(eq(source_document.id, doc.id));
    await writeEvent(tx, {
      id: operationId,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: PURPOSE_CHANGE_ACTION,
      subject_kind: 'source_document',
      subject_id: doc.id,
      outcome: 'success',
      payload: receipt,
      affected_scopes: [],
      ingest_at: new Date(),
    });
    return { receipt, replayed: false };
  });
  return result;
}

export async function readIngestionPurposeImpact(db: Db, sessionId: string, requestId?: string) {
  return db.transaction(
    async (tx) => {
      const [session] = await tx
        .select()
        .from(learning_session)
        .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
        .limit(1);
      if (!session?.source_document_id)
        throw new ApiError('not_found', 'ingestion source not found', 404);
      const [doc] = await tx
        .select()
        .from(source_document)
        .where(eq(source_document.id, session.source_document_id))
        .limit(1);
      if (!doc) throw new ApiError('not_found', 'source document not found', 404);
      const operationId = requestId ? purposeOperationId(sessionId, requestId) : null;
      const receipt = operationId ? await readPurposeReceipt(tx, operationId) : null;
      if (operationId && !receipt)
        throw new ApiError('not_found', 'purpose command not found', 404);
      const repairs = receipt ? await readPurposeRepairs(tx, receipt.operation_id) : [];
      const stop = [];
      for (const target of receipt?.stop ?? []) {
        const [bound] = await tx
          .select({ budget: learning_session.agent_budget })
          .from(learning_session)
          .where(eq(learning_session.id, target.session_id));
        const owner = parseAgentBudget(bound?.budget)?.execution_owner;
        stop.push({
          ...target,
          state:
            target.run_ref &&
            owner?.run_ref === target.run_ref &&
            owner.stop_request_id === receipt?.operation_id
              ? owner.stop_confirmed === true
                ? 'confirmed'
                : 'pending'
              : 'unknown',
        });
      }
      return {
        current: {
          session_id: sessionId,
          source_document_id: doc.id,
          version: doc.version,
          policy: readDocumentDerivationPolicy(doc.provenance),
          epoch: documentUsageEpoch(doc.provenance),
        },
        receipt,
        stop,
        repairs,
        cleanup: receipt?.cleanup_required ? 'pending_or_partial' : 'not_requested',
        sinks: {
          mem0: receipt?.cleanup_required ? 'pending_or_partial' : 'not_requested',
          briefs: (receipt?.brief_scopes ?? []).map((scope) => ({
            scope_key: scope.scope_key,
            state:
              repairs.find(
                (repair) => repair.sink === 'brief' && repair.source_id === scope.scope_key,
              )?.state ?? 'pending',
          })),
        },
        external_effect: 'unknown_or_irreversible',
        unattributed: 'unknown',
        backup: 'unknown',
        trace: 'unknown',
        sqlite_history: 'unknown',
        admission: {
          state: receipt?.admission_obligation ? 'pending' : 'unknown',
          effect: 'unknown',
          fence: 'active',
          reason: 'source_fence_active_history_unknown',
          operation_id: receipt?.operation_id ?? null,
          source_document_id: doc.id,
          unattributed_history: 'unknown',
          deliveries: await readAdmissionPurposeImpact(tx, doc.id),
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

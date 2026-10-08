import { z } from 'zod';
import { ProposalDecisionInput } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

async function withStartDb<T>(read: (db: Db) => Promise<T>): Promise<T> {
  try {
    const { db } = await import('@/db/client');
    return await read(db);
  } catch (error) {
    // Keep the ApiError and its shaping in the same Start ESM bundle.
    throw errorResponse(error);
  }
}

export const readStartWorkbenchSummary = () =>
  withStartDb(async (db) => {
    const { loadWorkbenchSummary } = await import('@/capabilities/shell/public');
    return loadWorkbenchSummary(db);
  });
export const readStartOvernightDigest = () =>
  withStartDb(async (db) => {
    const { loadTodayOvernightDigest } = await import('@/server/today/overnight-digest');
    return loadTodayOvernightDigest(db);
  });
export const readStartTodayCost = () =>
  withStartDb(async (db) => {
    const { loadTodayCost } = await import('@/capabilities/observability/public');
    return loadTodayCost(db);
  });
export const readStartProposalInbox = (input: unknown) =>
  withStartDb(async (db) => {
    const { readProposalInbox } = await import('@/capabilities/shell/public');
    return readProposalInbox(db, input);
  });
export const readStartAutoApplied = () =>
  withStartDb(async (db) => {
    const { getAutoAppliedDigest } = await import('@/server/proposals/auto-applied-read');
    return getAutoAppliedDigest(db);
  });
export const readStartKnowledgeTree = () =>
  withStartDb(async (db) => {
    const { loadTreeSnapshot } = await import('@/capabilities/knowledge/public');
    const { isLearnerVisibleKnowledgeId } = await import(
      '@/kernel/read-models/learner-knowledge-visibility'
    );
    const rows = await loadTreeSnapshot(db);
    return {
      rows: rows
        .filter((row) => isLearnerVisibleKnowledgeId(row.id))
        .map((row) => ({
          ...row,
          archived_at: row.archived_at?.toISOString() ?? null,
          last_evidence_at: row.last_evidence_at?.toISOString() ?? null,
          last_active_at: row.last_active_at.toISOString(),
        })),
    };
  });
export const readStartConjectures = () =>
  withStartDb(async (db) => {
    const { loadPrepDeskConjectures } = await import('@/capabilities/shell/public');
    return loadPrepDeskConjectures(db);
  });
export const readStartRecentAiChanges = () =>
  withStartDb(async (db) => {
    const { listNoteRefineChanges } = await import('@/capabilities/notes/public');
    const rows = await listNoteRefineChanges(db, {
      since: new Date(Date.now() - 24 * 60 * 60_000),
      limit: 25,
    });
    return {
      window_hours: 24 as const,
      rows: rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
    };
  });

const DecisionRequest = z.object({ id: z.string().trim().min(1), input: ProposalDecisionInput });
export type StartProposalDecisionRequest = z.input<typeof DecisionRequest>;
export const createStartProposalDecision = (input: unknown) =>
  withStartDb(async (db) => {
    const parsed = DecisionRequest.safeParse(input);
    if (!parsed.success)
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    const { createProposalDecision } = await import('@/server/proposals/decision-resource');
    const { wakeHubSyncAfterCommit } = await import('@/server/boss/hub-sync-wake');
    const resource = await createProposalDecision(db, parsed.data.id, parsed.data.input);
    // The canonical command has committed. Wake latency/failure cannot change success.
    void wakeHubSyncAfterCommit().catch(() => {});
    return resource;
  });

const UndoRequest = z.object({ artifactId: z.string().min(1), eventId: z.string().min(1) });
export type StartAiChangeUndoRequest = z.input<typeof UndoRequest>;
export const undoStartAiChange = (input: unknown) =>
  withStartDb(async (db) => {
    const parsed = UndoRequest.safeParse(input);
    if (!parsed.success)
      throw new ApiError('validation_error', 'artifact id and event id are required', 400);
    const { listNoteRefineChanges, undoNoteRefineApplyEvent } = await import(
      '@/capabilities/notes/public'
    );
    const { artifactId, eventId } = parsed.data;
    const changes = await listNoteRefineChanges(db, { artifactId, limit: 200 });
    if (!changes.some((row) => row.event_id === eventId)) {
      throw new ApiError(
        'not_found',
        `note refine apply event ${eventId} was not found for artifact ${artifactId}`,
        404,
      );
    }
    return undoNoteRefineApplyEvent(db, { applyEventId: eventId });
  });

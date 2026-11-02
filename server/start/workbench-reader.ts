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
    const { loadTodayOvernightDigest } = await import('@/kernel/read-models/overnight-digest');
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
    const { getAutoAppliedDigest } = await import('@/capabilities/shell/public');
    return getAutoAppliedDigest(db);
  });

function knowledgeTimestampJson(value: Date | string): string {
  // Raw SQL timestamps lack a Drizzle decoder. Preserve their precision and
  // keep decoded Dates in ISO form without suppressing invalid-value errors.
  return typeof value === 'string' ? value : value.toISOString();
}

export const readStartKnowledgeTree = async (input?: { subject?: string }) => {
  const { KnowledgeTreeQuerySchema, loadTreeSnapshot } = await import(
    '@/capabilities/knowledge/public'
  );
  const parsed = KnowledgeTreeQuerySchema.safeParse(input ?? {});
  if (!parsed.success) {
    // Preserve the HTTP tree route's code-only validation envelope.
    throw Response.json({ error: 'validation_error' }, { status: 400 });
  }
  return withStartDb(async (db) => {
    const { isLearnerVisibleKnowledgeId } = await import(
      '@/kernel/read-models/learner-knowledge-visibility'
    );
    const rows = await loadTreeSnapshot(db, parsed.data.subject);
    return {
      rows: rows
        .filter((row) => isLearnerVisibleKnowledgeId(row.id))
        .map((row) => ({
          ...row,
          archived_at: row.archived_at == null ? null : knowledgeTimestampJson(row.archived_at),
          last_evidence_at:
            row.last_evidence_at == null ? null : knowledgeTimestampJson(row.last_evidence_at),
          last_active_at: knowledgeTimestampJson(row.last_active_at),
        })),
    };
  });
};
export const readStartKnowledgeFrontier = () =>
  withStartDb(async (db) => {
    const { loadFrontierRail } = await import('@/capabilities/knowledge/public');
    return { rows: await loadFrontierRail(db) };
  });
export const readStartKnowledgeReviewDue = () =>
  withStartDb(async (db) => {
    const { loadReviewDueSummary } = await import('@/capabilities/knowledge/public');
    return loadReviewDueSummary(db);
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

export const readStartActiveProbes = () =>
  withStartDb(async (db) => {
    const { loadActiveProbes } = await import('@/capabilities/shell/public');
    return loadActiveProbes(db);
  });

export const readStartTeachingBrief = () =>
  withStartDb(async (db) => {
    const { loadTeachingBrief } = await import('@/capabilities/shell/public');
    return loadTeachingBrief(db);
  });

export const acknowledgeStartTeachingBrief = (body: string) =>
  withStartDb(async (db) => {
    const { TeachingBriefAckBodySchema, acknowledgeTeachingBriefOutcome } = await import(
      '@/capabilities/shell/public'
    );
    let rawBody: unknown = null;
    try {
      rawBody = JSON.parse(body);
    } catch {
      // Match HTTP's malformed-JSON path through the shared strict body schema.
    }
    const parsed = TeachingBriefAckBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }
    return acknowledgeTeachingBriefOutcome(db, parsed.data.probe_result_event_id);
  });

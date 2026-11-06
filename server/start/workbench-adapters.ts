// Start-side adapters for this family. `frontdoor.ts` loads this module from the API
// graph, so every adapter below runs with the initialized subject registry, config
// snapshot and database pool; each keeps its own conversion, error and deadline handling.

import type { z } from 'zod';
import type { ProposalDecisionInput } from '@/core/schema/proposal';
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

// Inbox read in the API graph. The Start page calls this through
// `context.adapters.workbench()`; running it here is what gives the response the
// hydrated config snapshot, so `auto_apply_enabled` reflects the live switch
// instead of the Start bundle's unhydrated default.
export const readStartProposalInbox = async (input: unknown) => {
  try {
    const [{ readProposalInbox }, { db }] = await Promise.all([
      import('@/capabilities/shell/public'),
      import('@/db/client'),
    ]);
    return await readProposalInbox(db, input);
  } catch (error) {
    throw errorResponse(error);
  }
};

export const readStartWorkbenchSummary = () =>
  withStartDb(async (db) => {
    const [{ loadWorkbenchSummary }, { queryReviewDue }] = await Promise.all([
      import('@/capabilities/shell/public'),
      import('@/capabilities/practice/scheduling/public'),
    ]);
    return loadWorkbenchSummary(db, { queryReviewDue });
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
export const readStartTaskFailureAlerts = () =>
  withStartDb(async (db) => {
    const { loadTaskFailureAlerts } = await import('@/capabilities/observability/public');
    return loadTaskFailureAlerts(db);
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
  const read = await withStartDb(async (db) => {
    const { readLearnerKnowledgeTree } = await import('@/capabilities/knowledge/public');
    return readLearnerKnowledgeTree(db, input ?? {});
  });
  if (!read.ok) {
    // Preserve the HTTP tree route's code-only validation envelope.
    throw Response.json({ error: 'validation_error' }, { status: 400 });
  }
  return {
    rows: read.rows.map((row) => ({
      ...row,
      archived_at: row.archived_at == null ? null : knowledgeTimestampJson(row.archived_at),
      last_evidence_at:
        row.last_evidence_at == null ? null : knowledgeTimestampJson(row.last_evidence_at),
      last_active_at: knowledgeTimestampJson(row.last_active_at),
    })),
  };
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
    const { readRecentAiChanges } = await import('@/capabilities/notes/public');
    const recent = await readRecentAiChanges(db);
    return {
      ...recent,
      rows: recent.rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
    };
  });

export type StartProposalDecisionRequest = {
  id: string;
  input: z.input<typeof ProposalDecisionInput>;
};
export const createStartProposalDecision = (input: unknown) =>
  withStartDb(async (db) => {
    const { commitProposalDecisionRequest } = await import('@/server/proposals/decision-resource');
    const request = (input ?? {}) as { id?: unknown; input?: unknown };
    return commitProposalDecisionRequest(db, request.id, request.input);
  });

export type StartAiChangeUndoRequest = { artifactId: string; eventId: string };
export const undoStartAiChange = (input: unknown) =>
  withStartDb(async (db) => {
    const { undoArtifactAiChange } = await import('@/capabilities/notes/public');
    const request = (input ?? {}) as { artifactId?: unknown; eventId?: unknown };
    return undoArtifactAiChange(db, request.artifactId, request.eventId);
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

export const workbenchAdapters = {
  acknowledgeStartTeachingBrief,
  createStartProposalDecision,
  readStartActiveProbes,
  readStartAutoApplied,
  readStartConjectures,
  readStartKnowledgeFrontier,
  readStartKnowledgeReviewDue,
  readStartKnowledgeTree,
  readStartOvernightDigest,
  readStartProposalInbox,
  readStartRecentAiChanges,
  readStartTaskFailureAlerts,
  readStartTeachingBrief,
  readStartTodayCost,
  readStartWorkbenchSummary,
  undoStartAiChange,
};

import {
  ProposalPageResponseSchema,
  type WorkbenchClient,
  proposalDecisionBody,
} from '@/capabilities/shell/ui-public';
import { ProposalDecisionResource } from '@/core/schema/proposal';
import { rejectUndoVersionConflict } from '@/ui/lib/undo-ai-change';
import { authenticatedStartFetch } from './authenticated-fetch';
import { startProbeAnswerClient } from './probe-answer-client';
import {
  acknowledgeStartTeachingBriefOutcome,
  decideStartProposal,
  getStartActiveProbes,
  getStartAutoApplied,
  getStartConjectures,
  getStartKnowledgeFrontier,
  getStartKnowledgeReviewDue,
  getStartKnowledgeTree,
  getStartOvernightDigest,
  getStartProposalInbox,
  getStartRecentAiChanges,
  getStartTaskFailureAlerts,
  getStartTeachingBrief,
  getStartTodayCost,
  getStartWorkbenchSummary,
  undoStartArtifactAiChange,
} from './workbench-function';

const transport = { fetch: authenticatedStartFetch };

// Keep the transport shape identical on both front doors: page copy reads
// `auto_apply_enabled` from whichever page the client returns.
function toProposalPageWire(json: string) {
  const page = ProposalPageResponseSchema.parse(JSON.parse(json));
  return {
    rows: page.rows,
    next_cursor: page.next_cursor,
    auto_apply_enabled: page.auto_apply_enabled,
  };
}

export const startWorkbenchClient: WorkbenchClient = {
  getWorkbenchSummary: () => getStartWorkbenchSummary(transport),
  getOvernightDigest: () => getStartOvernightDigest(transport),
  getTodayCost: () => getStartTodayCost(transport),
  getTaskFailureAlerts: () => getStartTaskFailureAlerts(transport),
  listDecisionProposalPage: (cursor) =>
    getStartProposalInbox({
      ...transport,
      data: {
        lane: 'decision',
        status: 'pending',
        limit: '500',
        cursor: cursor ?? undefined,
      },
    }).then(toProposalPageWire),
  listObservationProposalPreview: () =>
    getStartProposalInbox({
      ...transport,
      data: {
        lane: 'observation',
        status: 'pending',
        limit: '200',
      },
    }).then(toProposalPageWire),
  listAutoApplied: () => getStartAutoApplied(transport),
  decideProposal: (id, decision, opts) =>
    decideStartProposal({
      ...transport,
      data: {
        id,
        input: proposalDecisionBody(decision, opts),
      },
    }).then((json) => ProposalDecisionResource.parse(JSON.parse(json)).result),
  retractProposal: (id) =>
    decideStartProposal({
      ...transport,
      data: {
        id,
        input: { decision: 'retract' },
      },
    }).then((json) => ProposalDecisionResource.parse(JSON.parse(json)).result),
  getPrepDeskConjectures: () => getStartConjectures(transport),
  getActiveProbes: () => getStartActiveProbes(transport),
  submitProbeAnswer: startProbeAnswerClient,
  getTeachingBrief: () => getStartTeachingBrief(transport),
  ackTeachingBriefOutcome: (probeResultEventId) =>
    acknowledgeStartTeachingBriefOutcome({
      ...transport,
      data: JSON.stringify({ probe_result_event_id: probeResultEventId }),
    }),
  getRecentAiChanges: () => getStartRecentAiChanges(transport),
  undoAiChange: async (artifactId, eventId) =>
    rejectUndoVersionConflict(
      await undoStartArtifactAiChange({ ...transport, data: { artifactId, eventId } }),
    ),
};

// Shared by the today system notice and the admin home.
export const startTaskFailureAlertsClient = () => getStartTaskFailureAlerts(transport);
export const startKnowledgeFrontierClient = () => getStartKnowledgeFrontier(transport);
export const startKnowledgeReviewDueClient = () => getStartKnowledgeReviewDue(transport);

export const startKnowledgeTreeClient = (subject?: string) =>
  getStartKnowledgeTree({ ...transport, data: { subject: subject || undefined } });

import {
  ProposalPageResponseSchema,
  type WorkbenchClient,
  proposalDecisionBody,
} from '@/capabilities/shell/ui-public';
import { ProposalDecisionResource } from '@/core/schema/proposal';
import { rejectUndoVersionConflict } from '@/ui/lib/undo-ai-change';
import { authenticatedStartFetch } from './authenticated-fetch';
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
  getStartTeachingBrief,
  getStartTodayCost,
  getStartWorkbenchSummary,
  undoStartArtifactAiChange,
} from './workbench-function';

const transport = { fetch: authenticatedStartFetch };
export const startWorkbenchClient: WorkbenchClient = {
  getWorkbenchSummary: () => getStartWorkbenchSummary(transport),
  getOvernightDigest: () => getStartOvernightDigest(transport),
  getTodayCost: () => getStartTodayCost(transport),
  listDecisionProposalPage: (cursor) =>
    getStartProposalInbox({
      ...transport,
      data: {
        lane: 'decision',
        status: 'pending',
        limit: '500',
        cursor: cursor ?? undefined,
      },
    }).then((json) => ProposalPageResponseSchema.parse(JSON.parse(json))),
  listObservationProposalPreview: () =>
    getStartProposalInbox({
      ...transport,
      data: {
        lane: 'observation',
        status: 'pending',
        limit: '200',
      },
    }).then((json) => ProposalPageResponseSchema.parse(JSON.parse(json))),
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

export const startKnowledgeFrontierClient = () => getStartKnowledgeFrontier(transport);
export const startKnowledgeReviewDueClient = () => getStartKnowledgeReviewDue(transport);

export const startKnowledgeTreeClient = (subject?: string) =>
  getStartKnowledgeTree({ ...transport, data: { subject: subject || undefined } });

import {
  ProposalPageResponseSchema,
  type WorkbenchClient,
  proposalDecisionBody,
} from '@/capabilities/shell/ui-public';
import { ProposalDecisionResource } from '@/core/schema/proposal';
import { ApiError } from '@/ui/lib/api';
import { authenticatedStartFetch } from './authenticated-fetch';
import {
  decideStartProposal,
  getStartAutoApplied,
  getStartConjectures,
  getStartKnowledgeTree,
  getStartOvernightDigest,
  getStartProposalInbox,
  getStartRecentAiChanges,
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
  getTree: () => getStartKnowledgeTree(transport),
  getPrepDeskConjectures: () => getStartConjectures(transport),
  getRecentAiChanges: () => getStartRecentAiChanges(transport),
  undoAiChange: async (artifactId, eventId) => {
    const result = await undoStartArtifactAiChange({ ...transport, data: { artifactId, eventId } });
    if (result.status === 'skipped:version_conflict') {
      throw new ApiError('undo skipped: version_conflict', 409, 'version_conflict');
    }
    return result;
  },
};

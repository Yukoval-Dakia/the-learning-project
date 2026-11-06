import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { ProposalInboxQuery } from '@/capabilities/shell/public';
import type { StartAiChangeUndoRequest, StartProposalDecisionRequest } from './workbench-adapters';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartWorkbenchSummary = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartWorkbenchSummary } = await context.adapters.workbench();
    return readStartWorkbenchSummary();
  }),
);
export const getStartOvernightDigest = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartOvernightDigest } = await context.adapters.workbench();
    return readStartOvernightDigest();
  }),
);
export const getStartTodayCost = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartTodayCost } = await context.adapters.workbench();
    return readStartTodayCost();
  }),
);
export const getStartTaskFailureAlerts = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartTaskFailureAlerts } = await context.adapters.workbench();
    return readStartTaskFailureAlerts();
  }),
);
export const getStartAutoApplied = createServerFn({ method: 'GET' })
  .validator((window: { from: string; to?: string } | undefined) => window)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartAutoApplied } = await context.adapters.workbench();
      return readStartAutoApplied(data);
    }),
  );
export const retractStartAutoApplied = createServerFn({ method: 'POST' })
  .validator((input: { proposal_ids: string[] }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { retractStartAutoApplied: retract } = await context.adapters.workbench();
      return JSON.stringify(await retract(data));
    }),
  );
export const getStartKnowledgeTree = createServerFn({ method: 'GET' })
  .validator((input: { subject?: string } | undefined) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartKnowledgeTree } = await context.adapters.workbench();
      return readStartKnowledgeTree(data);
    }),
  );
export const getStartKnowledgeFrontier = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartKnowledgeFrontier } = await context.adapters.workbench();
    return readStartKnowledgeFrontier();
  }),
);
export const getStartKnowledgeReviewDue = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartKnowledgeReviewDue } = await context.adapters.workbench();
    return readStartKnowledgeReviewDue();
  }),
);
export const getStartConjectures = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartConjectures } = await context.adapters.workbench();
    return readStartConjectures();
  }),
);
export const getStartActiveProbes = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartActiveProbes } = await context.adapters.workbench();
    return readStartActiveProbes();
  }),
);
export const getStartTeachingBrief = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartTeachingBrief } = await context.adapters.workbench();
    return readStartTeachingBrief();
  }),
);
export const acknowledgeStartTeachingBriefOutcome = createServerFn({ method: 'POST' })
  .validator((body: string) => body)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { acknowledgeStartTeachingBrief } = await context.adapters.workbench();
      return acknowledgeStartTeachingBrief(data);
    }),
  );
export const getStartRecentAiChanges = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartRecentAiChanges } = await context.adapters.workbench();
    return readStartRecentAiChanges();
  }),
);
export const getStartProposalInbox = createServerFn({ method: 'GET' })
  .validator((input: ProposalInboxQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartProposalInbox } = await context.adapters.workbench();
      return JSON.stringify(await readStartProposalInbox(data));
    }),
  );
export const decideStartProposal = createServerFn({ method: 'POST' })
  .validator((input: StartProposalDecisionRequest) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { createStartProposalDecision } = await context.adapters.workbench();
      return JSON.stringify(await createStartProposalDecision(data));
    }),
  );
export const undoStartArtifactAiChange = createServerFn({ method: 'POST' })
  .validator((input: StartAiChangeUndoRequest) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { undoStartAiChange } = await context.adapters.workbench();
      return undoStartAiChange(data);
    }),
  );

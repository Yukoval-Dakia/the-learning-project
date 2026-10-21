import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { ProposalInboxQuery } from '@/capabilities/shell/public';
import { runAuthenticatedStartWorkbench } from './workbench-read';
import {
  type StartAiChangeUndoRequest,
  type StartProposalDecisionRequest,
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
  readStartTeachingBrief,
  readStartTodayCost,
  readStartWorkbenchSummary,
  undoStartAiChange,
} from './workbench-reader';

export const getStartWorkbenchSummary = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartWorkbenchSummary),
);
export const getStartOvernightDigest = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartOvernightDigest),
);
export const getStartTodayCost = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartTodayCost),
);
export const getStartAutoApplied = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartAutoApplied),
);
export const getStartKnowledgeTree = createServerFn({ method: 'GET' })
  .inputValidator((input: { subject?: string } | undefined) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), () => readStartKnowledgeTree(data)),
  );
export const getStartKnowledgeFrontier = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartKnowledgeFrontier),
);
export const getStartKnowledgeReviewDue = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartKnowledgeReviewDue),
);
export const getStartConjectures = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartConjectures),
);
export const getStartActiveProbes = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartActiveProbes),
);
export const getStartTeachingBrief = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartTeachingBrief),
);
export const getStartRecentAiChanges = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartRecentAiChanges),
);
export const getStartProposalInbox = createServerFn({ method: 'GET' })
  .inputValidator((input: ProposalInboxQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await readStartProposalInbox(data)),
    ),
  );
export const decideStartProposal = createServerFn({ method: 'POST' })
  .inputValidator((input: StartProposalDecisionRequest) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await createStartProposalDecision(data)),
    ),
  );
export const undoStartArtifactAiChange = createServerFn({ method: 'POST' })
  .inputValidator((input: StartAiChangeUndoRequest) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), () => undoStartAiChange(data)),
  );

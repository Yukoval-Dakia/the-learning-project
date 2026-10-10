import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { ProposalInboxQuery } from '@/capabilities/shell/public';
import { runAuthenticatedStartWorkbench } from './workbench-read';
import {
  type StartAiChangeUndoRequest,
  type StartProposalDecisionRequest,
  createStartProposalDecision,
  readStartAutoApplied,
  readStartConjectures,
  readStartKnowledgeTree,
  readStartOvernightDigest,
  readStartProposalInbox,
  readStartRecentAiChanges,
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
export const getStartKnowledgeTree = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartKnowledgeTree),
);
export const getStartConjectures = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), readStartConjectures),
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

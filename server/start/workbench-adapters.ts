import { readStartProposalInbox } from './workbench-inbox-reader';

// Workbench family: constructed in the API graph when a Start operation first
// asks for it, so config-dependent reads see the hydrated snapshot.
export const workbenchAdapters = {
  readStartProposalInbox,
};

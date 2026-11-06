// Inbox read in the API graph. The Start page calls this through
// `context.adapters.workbench()`; running it here is what gives the response the
// hydrated config snapshot, so `auto_apply_enabled` reflects the live switch
// instead of the Start bundle's unhydrated default.
import { errorResponse } from '@/kernel/http';

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

// Workbench family: constructed in the API graph when a Start operation first
// asks for it, so config-dependent reads see the hydrated snapshot.
export const workbenchAdapters = {
  readStartProposalInbox,
};

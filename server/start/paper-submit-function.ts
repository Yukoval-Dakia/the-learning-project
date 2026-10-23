import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const submitPaperSlotFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { sessionId: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.submitPaperSlot(data)),
    ),
  );

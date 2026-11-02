import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const answerStartConjectureProbeFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { probeId: string; body: string }) => input)
  .handler(({ context, data }) => {
    const request = getRequest();
    return runAuthenticatedStartWorkbench(context, request, async () =>
      JSON.stringify(await context.submitConjectureProbeAnswer(data, request.signal)),
    );
  });

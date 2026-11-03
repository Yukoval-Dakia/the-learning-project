import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const sendStartCopilotChatFunction = createServerFn({ method: 'POST' })
  .validator((body: string) => body)
  .handler(({ context, data }) => {
    const request = getRequest();
    return runAuthenticatedStartWorkbench(context, request, async () => {
      const result = await context.sendCopilotChat(
        { body: data, key: request.headers.get('Idempotency-Key') },
        request.signal,
      );
      return JSON.stringify({ ...result.body, location: result.headers.Location });
    });
  });

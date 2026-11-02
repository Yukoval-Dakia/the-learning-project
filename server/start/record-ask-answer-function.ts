import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseStatus } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const answerStartRecordAskFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { sessionId: string; askId: string; body: string }) => input)
  .handler(({ context, data }) => {
    const request = getRequest();
    return runAuthenticatedStartWorkbench(context, request, async () => {
      const result = await context.answerRecordAsk({
        ...data,
        key: request.headers.get('Idempotency-Key'),
      });
      setResponseStatus(202);
      return JSON.stringify(result);
    });
  });

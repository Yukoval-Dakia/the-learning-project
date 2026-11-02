import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const createStartRecordManualMistakeFunction = createServerFn({ method: 'POST' })
  .inputValidator((body: string) => body)
  .handler(({ context, data }) => {
    const request = getRequest();
    return runAuthenticatedStartWorkbench(context, request, async () => {
      const result = await context.createRecordManualMistake({
        body: data,
        key: request.headers.get('Idempotency-Key'),
      });
      setResponseStatus(result.status);
      setResponseHeader('Location', result.location);
      if (result.replayed) setResponseHeader('Idempotency-Replayed', 'true');
      return JSON.stringify(result.body);
    });
  });

import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const createStartIngestionOperationFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { sessionId: string; body: string }) => input)
  .handler(({ context, data }) => {
    const request = getRequest();
    return runAuthenticatedStartWorkbench(context, request, async () => {
      const result = await context.createIngestionOperation({
        ...data,
        key: request.headers.get('Idempotency-Key'),
      });
      setResponseStatus(result.status);
      for (const [name, value] of Object.entries(result.headers)) {
        setResponseHeader(name, value);
      }
      return JSON.stringify({ resource: result.resource, location: result.headers.Location });
    });
  });

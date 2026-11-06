import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const createStartIngestionSessionFunction = createServerFn({ method: 'POST' })
  .validator((body: string) => body)
  .handler(({ context, data }) => {
    const request = getRequest();
    return runAuthenticatedStartWorkbench(context, request, async () => {
      const { createStartIngestionSession } = await context.adapters.records();
      const result = await createStartIngestionSession({
        body: data,
        key: request.headers.get('Idempotency-Key'),
      });
      setResponseHeader('Location', result.location);
      if (result.replayed) setResponseHeader('Idempotency-Replayed', 'true');
      return JSON.stringify(result.body);
    });
  });

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const runStartLibraryServingActionFunction = createServerFn({ method: 'POST' })
  .validator((input: { path: string }) => input)
  .handler(({ context, data }) => {
    const request = getRequest();
    return runAuthenticatedStartWorkbench(context, request, async () => {
      const { runStartLibraryServingAction } = await context.adapters.library();
      return JSON.stringify(
        await runStartLibraryServingAction({
          path: data?.path,
          idempotencyKey: request.headers.get('Idempotency-Key'),
        }),
      );
    });
  });

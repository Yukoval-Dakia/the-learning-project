import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const runStartLibraryServingActionFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { path: string }) => input)
  .handler(({ context, data }) => {
    const request = getRequest();
    return runAuthenticatedStartWorkbench(context, request, async () =>
      JSON.stringify(
        await context.runLibraryServingAction({
          path: data?.path,
          idempotencyKey: request.headers.get('Idempotency-Key'),
        }),
      ),
    );
  });

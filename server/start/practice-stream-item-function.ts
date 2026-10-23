import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const updateStartPracticeStreamItemFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.updatePracticeStreamItem(data)),
    ),
  );

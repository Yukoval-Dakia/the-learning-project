import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartQuestionCardFunction = createServerFn({ method: 'GET' })
  .validator((input: { id: string; sessionId: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartQuestionCard } = await context.adapters.library();
      return JSON.stringify(await readStartQuestionCard(data.id, data.sessionId));
    }),
  );

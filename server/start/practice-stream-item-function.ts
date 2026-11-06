import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const updateStartPracticeStreamItemFunction = createServerFn({ method: 'POST' })
  .validator((input: { id: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { updateStartPracticeStreamItem } = await context.adapters.practiceStream();
      return JSON.stringify(await updateStartPracticeStreamItem(data));
    }),
  );

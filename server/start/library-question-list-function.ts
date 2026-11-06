import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartLibraryQuestionsFunction = createServerFn({ method: 'GET' })
  .validator((query: string) => query)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartLibraryQuestions } = await context.adapters.library();
      return JSON.stringify(await readStartLibraryQuestions(data));
    }),
  );

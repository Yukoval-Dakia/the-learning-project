import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const restoreStartLibraryQuestionFunction = createServerFn({ method: 'POST' })
  .validator((input: { id: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { restoreStartLibraryQuestion } = await import('./library-question-restore-operation');
      return JSON.stringify(await restoreStartLibraryQuestion(data));
    }),
  );

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const updateStartLibraryQuestionFunction = createServerFn({ method: 'POST' })
  .validator((input: { id: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { updateStartLibraryQuestion } = await import('./library-question-update-operation');
      return JSON.stringify(await updateStartLibraryQuestion(data));
    }),
  );

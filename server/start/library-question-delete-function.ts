import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const archiveStartLibraryQuestionFunction = createServerFn({ method: 'POST' })
  .validator((input: { id: string; query: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { archiveStartLibraryQuestion } = await import('./library-question-delete-operation');
      const result = await archiveStartLibraryQuestion(data);
      if (result.status !== 200) {
        throw Response.json(result.body, { status: result.status });
      }
      return JSON.stringify(result.body);
    }),
  );

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartLibraryQuestionDetailFunction = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartLibraryQuestionDetail } = await import('./library-question-detail-reader');
      return JSON.stringify(await readStartLibraryQuestionDetail(data));
    }),
  );

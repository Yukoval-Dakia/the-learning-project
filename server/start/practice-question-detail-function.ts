import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartPracticeQuestionDetailFunction = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartPracticeQuestionDetail } = await import(
        './practice-question-detail-operation'
      );
      return JSON.stringify(await readStartPracticeQuestionDetail(data));
    }),
  );

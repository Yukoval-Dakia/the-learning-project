import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartPracticeStreamFunction = createServerFn({ method: 'GET' })
  .validator((knowledgeId: string | undefined) => knowledgeId)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { getStartPracticeStream } = await context.adapters.practiceStream();
      return JSON.stringify(await getStartPracticeStream(data));
    }),
  );

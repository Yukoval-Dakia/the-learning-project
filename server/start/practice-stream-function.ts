import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartPracticeStreamFunction = createServerFn({ method: 'GET' })
  .inputValidator((knowledgeId: string | undefined) => knowledgeId)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.getPracticeStream(data)),
    ),
  );

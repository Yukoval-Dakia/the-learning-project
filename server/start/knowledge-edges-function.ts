import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartKnowledgeEdges = createServerFn({ method: 'GET' })
  .inputValidator((subject: string | undefined) => subject)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.readKnowledgeEdges(data)),
    ),
  );

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartKnowledgeEdges = createServerFn({ method: 'GET' })
  .validator((subject: string | undefined) => subject)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartKnowledgeEdges } = await context.adapters.knowledge();
      return JSON.stringify(await readStartKnowledgeEdges(data));
    }),
  );

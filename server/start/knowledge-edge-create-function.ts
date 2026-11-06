import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const createStartKnowledgeEdgeFunction = createServerFn({ method: 'POST' })
  .validator((body: string) => body)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { createStartKnowledgeEdge } = await import('./knowledge-edge-create-operation');
      return JSON.stringify(await createStartKnowledgeEdge(data));
    }),
  );

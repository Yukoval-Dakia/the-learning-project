import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartKnowledgeMisconceptions = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartKnowledgeMisconceptions } = await import(
        './knowledge-misconceptions-reader'
      );
      return JSON.stringify(await readStartKnowledgeMisconceptions(data));
    }),
  );

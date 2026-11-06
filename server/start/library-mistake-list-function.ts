import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartLibraryMistakesFunction = createServerFn({ method: 'GET' })
  .validator((query: string) => query)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartLibraryMistakes } = await import('./library-mistake-list-reader');
      return JSON.stringify(await readStartLibraryMistakes(data));
    }),
  );

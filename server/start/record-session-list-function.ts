import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartRecordSessionsFunction = createServerFn({ method: 'GET' })
  .validator((query: string) => query)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartRecordSessions } = await import('./record-session-list-reader');
      return JSON.stringify(await readStartRecordSessions(data));
    }),
  );

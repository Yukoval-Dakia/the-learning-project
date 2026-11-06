import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartRecordSessionDetailFunction = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartRecordSessionDetail } = await import('./record-session-detail-reader');
      return JSON.stringify(await readStartRecordSessionDetail(data));
    }),
  );

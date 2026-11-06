import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartRecordSessionHistoryFunction = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartRecordSessionHistory } = await context.adapters.records();
      return JSON.stringify(await readStartRecordSessionHistory(data));
    }),
  );

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const readStartWorksheetExportFunction = createServerFn({ method: 'GET' })
  .validator((token: string) => token)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.readWorksheetExport(data)),
    ),
  );

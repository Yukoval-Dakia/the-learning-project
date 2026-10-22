import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartJudgeRunStatus = createServerFn({ method: 'GET' })
  .inputValidator((runId: string) => runId)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.readJudgeRunStatus(data)),
    ),
  );

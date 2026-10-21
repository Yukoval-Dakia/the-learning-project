import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { WeeklyReportQuery } from '@/capabilities/practice/public';
import { readStartCoachWeekly } from './coach-reader';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartCoachWeekly = createServerFn({ method: 'GET' })
  .inputValidator((input: WeeklyReportQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await readStartCoachWeekly(data)),
    ),
  );

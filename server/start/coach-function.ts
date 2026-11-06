import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { WeeklyReportQuery } from '@/capabilities/practice/scheduling/public';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartCoachWeekly = createServerFn({ method: 'GET' })
  .validator((input: WeeklyReportQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartCoachWeekly } = await context.adapters.coach();
      return JSON.stringify(await readStartCoachWeekly(data));
    }),
  );

export const getStartCoachCalibration = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartCoachCalibration } = await context.adapters.coach();
    return JSON.stringify(await readStartCoachCalibration());
  }),
);

export const getStartCoachEffectiveness = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartCoachEffectiveness } = await context.adapters.coach();
    return JSON.stringify(await readStartCoachEffectiveness());
  }),
);

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const recomposeStartPracticeStreamFunction = createServerFn({ method: 'POST' }).handler(
  ({ context }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.recomposePracticeStream()),
    ),
);

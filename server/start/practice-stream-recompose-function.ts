import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const recomposeStartPracticeStreamFunction = createServerFn({ method: 'POST' }).handler(
  ({ context }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { recomposeStartPracticeStream } = await context.adapters.practiceStream();
      return JSON.stringify(await recomposeStartPracticeStream());
    }),
);

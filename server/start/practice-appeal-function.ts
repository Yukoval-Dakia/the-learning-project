import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const createStartPracticeAppealFunction = createServerFn({ method: 'POST' })
  .inputValidator((body: string) => body)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), () => context.createPracticeAppeal(data)),
  );

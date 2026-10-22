import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartSubjects = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), () => context.readSubjects()),
);

export const createStartSubjectFunction = createServerFn({ method: 'POST' })
  .inputValidator((displayName: string) => displayName)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.createSubject(data)),
    ),
  );

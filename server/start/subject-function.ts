import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartSubjects = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), async () => {
    const { readStartSubjects } = await context.adapters.subjects();
    return readStartSubjects();
  }),
);

export const createStartSubjectFunction = createServerFn({ method: 'POST' })
  .validator((displayName: string) => displayName)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { createStartSubject } = await context.adapters.subjects();
      return JSON.stringify(await createStartSubject(data));
    }),
  );

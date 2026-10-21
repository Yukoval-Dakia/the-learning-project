import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartSubjects = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartWorkbench(context, getRequest(), () => context.readSubjects()),
);

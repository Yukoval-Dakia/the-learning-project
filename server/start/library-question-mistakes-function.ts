import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartLibraryQuestionMistakesFunction = createServerFn({ method: 'GET' })
  .inputValidator((id: string) => id)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.readLibraryQuestionMistakes(data)),
    ),
  );

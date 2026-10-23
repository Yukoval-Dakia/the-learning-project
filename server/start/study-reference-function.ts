import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const revealStartStudyReferenceFunction = createServerFn({ method: 'POST' })
  .inputValidator((issuanceId: string) => issuanceId)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.revealStudyReference(data)),
    ),
  );

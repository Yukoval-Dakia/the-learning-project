import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const previewStartReviewAdviceFunction = createServerFn({ method: 'POST' })
  .inputValidator((body: string) => body)
  .handler(({ context, data }) => {
    const request = getRequest();
    return runAuthenticatedStartWorkbench(context, request, async () =>
      JSON.stringify(await context.previewReviewAdvice(data, request.signal)),
    );
  });

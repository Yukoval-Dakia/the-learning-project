import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const changeStartRecordPurposeFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { sessionId: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const result = await context.changeRecordPurpose(data);
      for (const [name, value] of Object.entries(result.headers)) {
        setResponseHeader(name, value);
      }
      return JSON.stringify({ ...result.body, location: result.headers.Location });
    }),
  );

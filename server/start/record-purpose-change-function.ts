import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const changeStartRecordPurposeFunction = createServerFn({ method: 'POST' })
  .validator((input: { sessionId: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { changeStartRecordPurpose } = await import('./record-purpose-change-operation');
      const result = await changeStartRecordPurpose(data);
      for (const [name, value] of Object.entries(result.headers)) {
        setResponseHeader(name, value);
      }
      return JSON.stringify({ ...result.body, location: result.headers.Location });
    }),
  );

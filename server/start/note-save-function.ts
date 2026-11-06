import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

// JSON preserves arbitrary block attributes in both directions. Input validation
// and the canonical edit stay behind the same token/epoch gate as HTTP.
export const postStartNoteSave = createServerFn({ method: 'POST' })
  .validator((input: { id: string; body: string }) => input)
  .handler(async ({ context, data }) =>
    JSON.stringify(
      await runAuthenticatedStartWorkbench(context, getRequest(), async () => {
        const { saveStartNoteBody } = await context.adapters.notes();
        return saveStartNoteBody(data);
      }),
    ),
  );

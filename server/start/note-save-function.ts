import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartNoteSave } from './note-save-write';

// JSON preserves arbitrary block attributes in both directions. Input validation
// and the canonical edit stay behind the same token/epoch gate as HTTP.
export const postStartNoteSave = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<typeof runAuthenticatedStartNoteSave>[2]) => input)
  .handler(async ({ context, data }) =>
    JSON.stringify(await runAuthenticatedStartNoteSave(context, getRequest(), data)),
  );

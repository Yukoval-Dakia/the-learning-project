import type { NoteSaveClient } from '@/capabilities/notes/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { postStartNoteSave } from './note-save-function';

// Like the HTTP client, decode the canonical writer's JSON receipt without
// applying the narrower documentation-only block schema after the edit commits.
export const startNoteSaveClient: NoteSaveClient = async (id, input) =>
  JSON.parse(
    await postStartNoteSave({
      fetch: authenticatedStartFetch,
      data: { id, body: JSON.stringify(input) },
    }),
  );

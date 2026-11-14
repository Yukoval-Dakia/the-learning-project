import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

// Validate after authorization; JSON retains the HTTP wire representation of
// arbitrary block attributes and history timestamps across Seroval.
export const getStartNotePage = createServerFn({ method: 'GET' })
  .validator((input: { id: string }) => input)
  .handler(async ({ context, data }) =>
    JSON.stringify(
      await runAuthenticatedStartWorkbench(context, getRequest(), async () => {
        const { readStartNotePage } = await context.adapters.notes();
        return readStartNotePage(data);
      }),
    ),
  );

export const openStartPracticeNote = createServerFn({ method: 'POST' })
  .validator(
    (input: { id: string; issuance_id: string; question_id: string; entry_knowledge_id: string }) =>
      input,
  )
  .handler(async ({ context, data }) =>
    JSON.stringify(
      await runAuthenticatedStartWorkbench(context, getRequest(), async () => {
        const { openStartPracticeNotePage } = await context.adapters.notes();
        return openStartPracticeNotePage(data);
      }),
    ),
  );

// Date fields retain the same ISO JSON representation as the old HTTP response.
export const getStartNoteAiChanges = createServerFn({ method: 'GET' })
  .validator((input: { id: string }) => input)
  .handler(async ({ context, data }) =>
    JSON.stringify(
      await runAuthenticatedStartWorkbench(context, getRequest(), async () => {
        const { readStartNoteAiChanges } = await context.adapters.notes();
        return readStartNoteAiChanges(data);
      }),
    ),
  );

export const getStartNoteReferences = createServerFn({ method: 'GET' })
  .validator((input: { q: string; exclude?: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { searchStartNoteReferences } = await context.adapters.notes();
      return searchStartNoteReferences(data);
    }),
  );

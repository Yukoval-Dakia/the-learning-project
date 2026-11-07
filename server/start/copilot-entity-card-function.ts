import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartEntityCardFunction = createServerFn({ method: 'GET' })
  .validator((input: { kind: 'knowledge' | 'note'; id: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      if (data.kind === 'knowledge') {
        const { readStartKnowledgeEntityCard } = await context.adapters.knowledge();
        return JSON.stringify(await readStartKnowledgeEntityCard(data.id));
      }
      const { readStartNoteEntityCard } = await context.adapters.notes();
      return JSON.stringify(await readStartNoteEntityCard(data.id));
    }),
  );

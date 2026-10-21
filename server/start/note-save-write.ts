import type { FrontdoorContext } from './context';
import type { saveStartNoteBody } from './note-save-operation';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export function runAuthenticatedStartNoteSave(
  context: Pick<FrontdoorContext, 'api'>,
  request: Request,
  input: Parameters<typeof saveStartNoteBody>[0],
  options?: Parameters<typeof saveStartNoteBody>[1],
) {
  return runAuthenticatedStartWorkbench(context, request, async () => {
    const { saveStartNoteBody } = await import('./note-save-operation');
    return saveStartNoteBody(input, options);
  });
}

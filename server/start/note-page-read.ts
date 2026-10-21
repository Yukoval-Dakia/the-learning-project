import type { FrontdoorContext } from './context';
import { readStartNoteAiChanges, readStartNotePage } from './note-page-reader';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export function runAuthenticatedStartNotePage(
  context: Pick<FrontdoorContext, 'api'>,
  request: Request,
  input: Parameters<typeof readStartNotePage>[0],
  options?: Parameters<typeof readStartNotePage>[1],
) {
  return runAuthenticatedStartWorkbench(context, request, () => readStartNotePage(input, options));
}

export function runAuthenticatedStartNoteAiChanges(
  context: Pick<FrontdoorContext, 'api'>,
  request: Request,
  input: Parameters<typeof readStartNoteAiChanges>[0],
  options?: Parameters<typeof readStartNoteAiChanges>[1],
) {
  return runAuthenticatedStartWorkbench(context, request, () =>
    readStartNoteAiChanges(input, options),
  );
}

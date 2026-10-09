import type { NoteListQuery } from '@/capabilities/notes/public';
import type { FrontdoorContext } from './context';
import { readStartNoteList } from './notes-list-reader';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export function runAuthenticatedStartNoteList(
  context: Pick<FrontdoorContext, 'api'>,
  request: Request,
  input: NoteListQuery,
  options?: Parameters<typeof readStartNoteList>[1],
) {
  return runAuthenticatedStartWorkbench(context, request, () => readStartNoteList(input, options));
}

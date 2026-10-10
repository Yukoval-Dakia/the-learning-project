import type { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { AgentNotesQuerySchema } from '../api/contracts';
import { type AgentNoteBoardRow, readAgentNoteBoardRows } from './notes';

export type AgentNoteBoardQuery = z.input<typeof AgentNotesQuerySchema>;
export type AgentNoteBoardRowDto = Omit<AgentNoteBoardRow, 'created_at'> & {
  created_at: string;
};
export type AgentNoteBoardDto = { rows: AgentNoteBoardRowDto[] };

/** Read the unfiltered learner board on the caller's database and clock sample. */
export async function loadAgentNoteBoard(
  database: Db | Tx,
  input: AgentNoteBoardQuery,
  now: Date,
): Promise<AgentNoteBoardDto> {
  const parsed = AgentNotesQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      400,
    );
  }
  const rows = await readAgentNoteBoardRows(database, { now, limit: parsed.data.limit });
  return { rows: rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })) };
}

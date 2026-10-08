import type { AgentNoteBoardQuery } from '@/capabilities/agency/public';
import type { Db, Tx } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

// Called only inside the token/epoch guard. Domain owns validation, selection and ISO DTOs.
export async function readStartAgentNoteBoard(
  input: AgentNoteBoardQuery,
  options: { database?: Db | Tx; now?: Date } = {},
) {
  try {
    const now = options.now ?? new Date();
    const { AgentNotesQuerySchema, loadAgentNoteBoard } = await import(
      '@/capabilities/agency/public'
    );
    const parsed = AgentNotesQuerySchema.safeParse(input);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }
    const database = options.database ?? (await import('@/db/client')).db;
    return await loadAgentNoteBoard(database, input, now);
  } catch (error) {
    // Shape ApiError within the Start ESM bundle, before crossing the CJS host boundary.
    throw errorResponse(error);
  }
}

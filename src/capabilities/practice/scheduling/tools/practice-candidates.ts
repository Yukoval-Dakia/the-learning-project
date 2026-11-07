// read_practice_candidates — YUK-1790 LIGHT coach-facing read of the session owner's
// candidate union. Read-only: no queue write, no booking, no provider call.
import {
  type PracticeCandidateQuery,
  PracticeCandidateQuerySchema,
  type PracticeCandidateRead,
  PracticeCandidateReadSchema,
} from '@/core/schema/practice-candidate';
import type { DomainTool } from '@/kernel/tools/types';
import { readPracticeCandidates, summarizeCandidateRead } from '../server/practice-candidates';

export const readPracticeCandidatesTool: DomainTool<PracticeCandidateQuery, PracticeCandidateRead> =
  {
    name: 'read_practice_candidates',
    description:
      'Read the servable practice candidate union for a scope: due cards, admitted mistake variants, new-check knowledge points, the real prerequisite frontier, in-scope never-started admitted questions, and doable paper containers. Every row carries its question revision/digest, prompt excerpt (no answer key), knowledge signals (mastery/evidence/retention/streak/top causes), due facts, difficulty/MFI and servability evidence; a missing reading is {known:false, missingReason} — never zero and never a low-mastery claim. Pages of one planning read share snapshot_id; a changed set returns status=snapshot_changed with no rows, and an unresolvable scope returns status=scope_unresolved (never an empty ok page). gaps are deterministic empty-pool facts. The default page is small enough to read into context; pass pageSize (max 30) and follow next_cursor for more. Read-only: it never writes the queue, a plan or evidence.',
    effect: 'read',
    inputSchema: PracticeCandidateQuerySchema,
    outputSchema: PracticeCandidateReadSchema,
    costClass: 'local',
    execute: async (ctx, input) => readPracticeCandidates(ctx.db, input),
    summarize: (_input, output) => summarizeCandidateRead(output),
    mirrorEvent: 'when_user_visible',
  };

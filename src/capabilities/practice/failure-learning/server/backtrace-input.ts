import { createHash } from 'node:crypto';
import type { Db, Tx } from '@/db/client';
import { readGradedAttempt } from '@/kernel/read-models/graded-attempt';
import { projectFrozenStudyContext } from '../../grading/public';

export const backtraceDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function loadBacktraceInput(db: Db | Tx, id: string) {
  const row = await readGradedAttempt(db, id);
  if (!row) return null;
  const { native_revision, visible: _visible, ...evidence } = row;
  const frozen = native_revision
    ? projectFrozenStudyContext(native_revision.revision, native_revision.issuance)
    : null;
  const input = {
    ...evidence,
    prompt_md: frozen?.prompt_md ?? row.prompt_md,
    reference_md: frozen
      ? [frozen.reference_md, frozen.solution_md].filter(Boolean).join('\n')
      : row.reference_md,
  };
  // Feedback release is presentation state and must not cause a second paid extraction.
  return {
    input,
    // Keep evidence identity stable: a task/schema upgrade must not bypass unresolved sends.
    digest: backtraceDigest({ version: 'attempt-insight-v1', input }),
    visible: row.visible,
  };
}

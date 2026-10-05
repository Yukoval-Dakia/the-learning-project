import type { Db } from '@/db/client';
import { resolveLiveArtifactPrimaryView } from './notes-integration';
import { isLiveQuestionReference } from './practice-port';

const QUESTION_KINDS = new Set(['question', '题', '题目']);

/** Validate a persisted hero through the capability that owns its product row. */
export async function resolveLivePrimaryViewArtifact(
  db: Db,
  ref: { kind: string; id: string },
): Promise<{ kind: string; id: string } | null> {
  const normalized = ref.kind.trim().toLowerCase();
  return QUESTION_KINDS.has(normalized)
    ? (await isLiveQuestionReference(db, ref.id))
      ? { kind: 'question', id: ref.id }
      : null
    : resolveLiveArtifactPrimaryView(db, ref);
}

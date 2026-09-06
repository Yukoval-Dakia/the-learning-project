import type { Db } from '@/db/client';
import { isLiveArtifactPrimaryView } from './notes-integration';
import { isLiveQuestionReference } from './practice-port';

const QUESTION_KINDS = new Set(['question', '题', '题目']);

/** Validate a persisted hero through the capability that owns its product row. */
export function isLivePrimaryViewArtifact(
  db: Db,
  ref: { kind: string; id: string },
): Promise<boolean> {
  const normalized = ref.kind.trim().toLowerCase();
  return QUESTION_KINDS.has(normalized)
    ? isLiveQuestionReference(db, ref.id)
    : isLiveArtifactPrimaryView(db, ref);
}

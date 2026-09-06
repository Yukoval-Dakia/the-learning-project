import { bodyBlocksToNoteSections, getLiveArtifactType } from '@/capabilities/notes/public';
import type { Db } from '@/db/client';

export { bodyBlocksToNoteSections };

function artifactKindMatchesType(kind: string, artifactType: string): boolean {
  const normalized = kind.trim().toLowerCase();
  if (artifactType === 'tool_quiz') {
    return ['tool_quiz', 'quiz', 'paper', '卷', '试卷'].includes(normalized);
  }
  if (artifactType === 'interactive') return normalized === 'interactive' || normalized === '互动';
  if (
    artifactType === 'note_atomic' ||
    artifactType === 'note_long' ||
    artifactType === 'note_hub'
  ) {
    return normalized === artifactType || normalized === 'note' || normalized === '笔记';
  }
  return normalized === artifactType;
}

/** Validate Copilot's semantic kind against the Notes-owned live artifact row. */
export async function isLiveArtifactPrimaryView(
  db: Db,
  ref: { kind: string; id: string },
): Promise<boolean> {
  const artifactType = await getLiveArtifactType(db, ref.id);
  return artifactType !== null && artifactKindMatchesType(ref.kind, artifactType);
}

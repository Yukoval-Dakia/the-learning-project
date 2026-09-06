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
export async function resolveLiveArtifactPrimaryView(
  db: Db,
  ref: { kind: string; id: string },
): Promise<{ kind: string; id: string } | null> {
  const artifactType = await getLiveArtifactType(db, ref.id);
  if (artifactType === null || !artifactKindMatchesType(ref.kind, artifactType)) return null;
  // Publish the existing product navigation contract, not a storage type that
  // the client can only render as a link-less label.
  const kind = artifactType.startsWith('note_')
    ? 'note'
    : artifactType === 'tool_quiz'
      ? 'quiz'
      : artifactType;
  return { kind, id: ref.id };
}

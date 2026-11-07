// Pure target fingerprint: the 7-day dispatch cooldown key. Kept free of runtime imports so
// operator tooling can derive a target without loading the DB, boss or capability barrels.
import type { DifficultyBand, SupplyGapKind } from './target-discovery';

/** Stable fingerprint (subjectId+knowledgeIds+kind+difficultyBand+gapKind+minSourceTier). */
export function targetFingerprint(parts: {
  kindSet?: readonly string[];
  subjectId: string;
  knowledgeIds: string[];
  kind: string;
  difficultyBand: DifficultyBand;
  gapKind: SupplyGapKind;
  minSourceTier: 1 | 2 | 3;
}): string {
  const kids = [...parts.knowledgeIds].sort().join(',');
  return [
    parts.subjectId,
    kids,
    parts.kindSet?.length ? JSON.stringify([...new Set(parts.kindSet)].sort()) : parts.kind,
    parts.difficultyBand,
    parts.gapKind,
    `t${parts.minSourceTier}`,
  ].join('|');
}

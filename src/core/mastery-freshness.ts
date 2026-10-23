export type MasteryDecayBucket = 'untrained' | 'fresh' | 'mild' | 'stale' | 'unknown';

export function masteryDecayBucket(
  evidenceCount: number,
  lastEvidenceAt: Date | null,
  now = new Date(),
): MasteryDecayBucket {
  if (evidenceCount <= 0) return 'untrained';
  if (!lastEvidenceAt) return 'unknown';
  const ageDays = Math.max(0, Math.floor((now.getTime() - lastEvidenceAt.getTime()) / 86_400_000));
  if (ageDays >= 30) return 'stale';
  if (ageDays >= 7) return 'mild';
  return 'fresh';
}

// The aggregate is the worst bucket across knowledge nodes: a question is only as
// fresh as its least-fresh concept. Derived, never stored.
const DECAY_SEVERITY: Record<MasteryDecayBucket, number> = {
  stale: 4,
  mild: 3,
  fresh: 2,
  untrained: 1,
  unknown: 0,
};

export function worstMasteryDecayBucket(
  buckets: readonly MasteryDecayBucket[],
): MasteryDecayBucket {
  return buckets.reduce<MasteryDecayBucket>((worst, bucket) => {
    return DECAY_SEVERITY[bucket] > DECAY_SEVERITY[worst] ? bucket : worst;
  }, 'unknown');
}

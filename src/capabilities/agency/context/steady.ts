import type { Db, Tx } from '@/db/client';
import { readMemoryBriefNote } from './memory-brief';
import { readTopics } from './topics';
import type { SteadySection } from './types';

type DbLike = Db | Tx;

/** 无 Dreaming 固化记录时 Δ 段的回看窗（companion 渲染按天如实标注）。 */
export const DELTA_FALLBACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export async function readSteadySection(db: DbLike, opts: { now: Date }): Promise<SteadySection> {
  const { digest, version } = await readTopics(db);
  const legacy = version === 0 ? (await readMemoryBriefNote(db, 'global')).note : null;
  const dreamingAt = digest.as_of ? new Date(digest.as_of) : null;
  const portrait = digest.topics
    .filter((t) => t.key !== 'communication')
    .map((t) => `${t.name}：${t.facts.map((f) => f.body).join('；')}`)
    .join('\n');
  return {
    portraitMd:
      portrait ||
      legacy?.recent_week_md ||
      legacy?.long_term_md ||
      legacy?.recent_months_md ||
      null,
    asOf: dreamingAt ?? new Date(opts.now.getTime() - DELTA_FALLBACK_LOOKBACK_MS),
    asOfBasis: dreamingAt ? 'dreaming' : 'lookback',
    communicationMd:
      digest.topics
        .find((t) => t.key === 'communication')
        ?.facts.map((f) => f.body)
        .join('；') ?? null,
    overnightMd: digest.overnight,
  };
}

// coach view (YUK-1790 LIGHT): the planning-facing startup segment. It reuses the same
// purpose-trimmed readers as companion/curator but keeps only what a planner needs —
// active goal + Steering, recent activity counts, mastery/cause readings, and the recent
// failure cause labels. No question stem, no answer key and no third-party material ride
// this view, so serving/revision checks stay with the candidate read (they own question
// content). `trimUnitsToBudget` is the shared budget base: Steering is never dropped whole.
import type { Db, Tx } from '@/db/client';
import type { LearnerContextResult } from '@/kernel/read-models/learner-context';
import { trimUnitsToBudget } from './budget';
import { readContractSection } from './contract';
import { type DeltaSection, readDeltaSection, shanghaiLabel } from './delta';
import { readSteadySection } from './steady';

type DbLike = Db | Tx;

/** Coach planning segment: smaller than companion's 1000 — the plan input carries more. */
const COACH_VIEW_BUDGET = { maxEstimatedTokens: 800, maxChars: 2000 } as const;

const FAILURE_STREAK_HEADER_MIN = 3;

function renderActivity(delta: DeltaSection): string {
  const parts = [
    delta.counts.answers > 0 ? `新作答 ${delta.counts.answers} 次` : '',
    delta.counts.reviews > 0 ? `复习 ${delta.counts.reviews} 次` : '',
    delta.counts.steering > 0 ? `目标调整 ${delta.counts.steering} 次` : '',
    delta.counts.decisions > 0 ? `提议决策 ${delta.counts.decisions} 条` : '',
  ].filter((part) => part.length > 0);
  const windowLabel = delta.countsWindowLimited ? '（最近活动窗口内）' : '';
  const due = `今日待复习 ${delta.reviewDueOverCap ? `${delta.reviewDueCount}+` : delta.reviewDueCount} 项`;
  const tail = [due];
  if (delta.failureStreak && delta.failureStreak.count >= FAILURE_STREAK_HEADER_MIN) {
    tail.push(`连续答错：${delta.failureStreak.knowledge_name}（${delta.failureStreak.count} 次）`);
  }
  if (delta.lastActivityAt) tail.push(`最近活动 ${shanghaiLabel(delta.lastActivityAt)}`);
  const head = parts.length > 0 ? `${parts.join('，')}${windowLabel}` : `未见新学习动态${windowLabel}`;
  return `${head}\n${tail.join('；')}`;
}

export async function assembleCoachContext(
  db: DbLike,
  opts: { now: Date; budget?: number },
): Promise<LearnerContextResult> {
  const steady = await readSteadySection(db, { now: opts.now });
  const [delta, contract] = await Promise.all([
    readDeltaSection(db, { asOf: steady.asOf, asOfBasis: steady.asOfBasis, now: opts.now }),
    readContractSection(db, { now: opts.now }),
  ]);
  const masteryMd = [contract.masteryMd, contract.causesMd].filter(Boolean).join('\n') || null;
  const trimmed = trimUnitsToBudget(
    [
      { rank: 0, name: 'steering', markdown: contract.steeringMd },
      { rank: 1, name: 'activity', markdown: renderActivity(delta) },
      { rank: 2, name: 'mastery_causes', markdown: masteryMd },
      { rank: 3, name: 'failure_details', markdown: contract.failureDetailsMd, dropRank: 6 },
      {
        rank: 4,
        name: 'portrait',
        markdown: steady.portraitMd ? `画像：${steady.portraitMd}` : null,
      },
    ],
    { ...COACH_VIEW_BUDGET, maxEstimatedTokens: opts.budget ?? COACH_VIEW_BUDGET.maxEstimatedTokens },
  );
  return {
    view: 'coach',
    markdown: trimmed.markdown,
    estimatedTokens: trimmed.estimatedTokens,
    startupTrim: {
      droppedUnits: trimmed.droppedUnits,
      tokensBeforeTrim: trimmed.tokensBeforeTrim,
    },
    asOf: steady.asOf.toISOString(),
    asOfBasis: steady.asOfBasis,
  };
}

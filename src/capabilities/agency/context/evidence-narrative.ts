import type { LearnerJudgment } from '@/core/schema/learner-judgment';
import type { readLearnerProfilesAsBatch } from '@/kernel/learner-profile/read';

type ProfileBatch = Awaited<ReturnType<typeof readLearnerProfilesAsBatch>>;

const EVIDENCE_PREVIEW_LIMIT = 2;

function abilityClaim(item: LearnerJudgment): string {
  switch (item.ability_claim.kind) {
    case 'low_observed':
      return '既有作答证据偏低';
    case 'observed':
      return '已有作答证据';
    case 'insufficient_evidence':
      return '证据不足，不能说弱';
    case 'not_evaluable':
      return '不评掌握';
    case 'unavailable':
      return '读取失败，不能判断';
  }
}

// These are read-time interpretations, never revisions of stored memory facts.
export function renderEvidenceNarrative(batch: ProfileBatch | null, current: string): string {
  const evidence = batch?.items.slice(0, EVIDENCE_PREVIEW_LIMIT).map((item) => {
    const freshness = batch.profile_freshness.get(item.knowledge_id);
    const source =
      item.ability_claim.kind === 'unavailable'
        ? '档案不可用'
        : freshness?.kind === 'current'
          ? `档案v${freshness.profile_version}`
          : freshness?.kind === 'stale'
            ? '档案待刷新，同快照重建'
            : '缺档，同快照重建';
    const reading = item.ability.kind === 'available' ? item.ability.reading : null;
    const sample = reading
      ? `n=${reading.evidence_count}/${reading.provenance}${reading.evidence_count < 5 ? '，样本少' : ''}`
      : 'n未知';
    const last = item.evidence_timing.last_outcome_at?.toISOString() ?? '未知';
    const age = item.uncertainty.evidence_age;
    const aging = age.kind === 'dated' && age.growing ? '，证据变旧' : '';
    return `[${item.knowledge_id}]${abilityClaim(item)}（${sample}；${source}；最近作答${last}${aging}）`;
  });
  const omitted = Math.max(0, (batch?.items.length ?? 0) - EVIDENCE_PREVIEW_LIMIT);
  const coverage = omitted > 0 ? `；另n=${omitted}项未展开，不能外推其结论` : '';
  const basis = evidence?.length
    ? `学情档案：${evidence.join('；')}${coverage}`
    : '无当前目标范围的学情档案证据，不能据历史记忆断言当前弱点';
  return [
    `我觉得你怎样：${current}`,
    `凭什么：${basis}。`,
    '哪里没把握：尚未个人校准；独立作答、受助、自评证据未拆分；连续答对五次未知，累计答对不能代替连续或独立证据。',
    '什么会改变我的看法：同知识点的新作答或学习者明确纠正需要复核；具体改判条件未知，不据掌握汇总自动宣称旧弱点已改善，明确纠正优先。',
  ].join('\n');
}

// Keep this qualification with memory even if the profile unit is budget-trimmed.
export function renderMemoryEvidence(portrait: string | null): string | null {
  return portrait
    ? `记忆线索（弱点仅为历史证据，当前状态待复核；学习者明确纠正优先）：${portrait}`
    : null;
}

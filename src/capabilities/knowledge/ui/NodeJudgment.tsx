// Read-only presentation of the published node-page judgment, shared by detail and drawer.
import { Button } from '@/ui-next/public';
import type { KnowledgeNodePage } from './knowledge-api';

type NodeJudgmentReading = KnowledgeNodePage['judgment'];

// ability_claim kind → label. The note below stays inside the published
// reading; it does not reinterpret the canonical judgement sentence.
const ABILITY_CLAIM_LABEL: Record<NodeJudgmentReading['ability_claim']['kind'], string> = {
  low_observed: '掌握读数偏低',
  observed: '掌握读数',
  insufficient_evidence: '证据不足，尚未判断',
  not_evaluable: '此节点不评掌握',
  unavailable: '掌握部件暂不可用',
};

function abilityClaimNote(claim: NodeJudgmentReading['ability_claim']): string | null {
  switch (claim.kind) {
    case 'low_observed':
      return '本人作答读数在低掌握一侧，尚未个人校准。';
    case 'observed':
      return '本人作答读数不在低掌握一侧。';
    case 'insufficient_evidence':
      return claim.reason === 'inferred_only'
        ? '目前只有知识关联推断，还没有本人作答证据。'
        : '本人作答证据不足，暂不判断会与不会。';
    case 'not_evaluable':
      return '此节点是目标或容器，不参与掌握评估。';
    case 'unavailable':
      return '掌握部件读取失败，请稍后再看。';
  }
}

function evidenceAgeText(age: NodeJudgmentReading['uncertainty']['evidence_age']): string {
  switch (age.kind) {
    case 'dated': {
      const day = age.idle_days === 0 ? '今天' : `${age.idle_days} 天前`;
      const fresh =
        age.freshness === 'fresh' ? '还新' : age.freshness === 'mild' ? '开始变旧' : '已旧';
      return `作答约在 ${day}（${fresh}）${age.growing ? '；不确定随闲置在增大' : '；不确定未随闲置增大'}`;
    }
    case 'undated':
      return '有作答但没有时间戳，无法判断不确定是否在增大。';
    case 'not_applicable':
      return age.reason === 'knowledge_role_not_mastery_evaluable'
        ? '此节点不评掌握，无随时间变化的本人估计。'
        : '没有可随时间变宽的本人估计。';
  }
}

function disagreementText(
  disagreement: NodeJudgmentReading['uncertainty']['component_disagreement'],
): string {
  switch (disagreement.kind) {
    case 'divergence_observed':
      return disagreement.direction === 'ability_high_retention_low'
        ? '掌握读数高于分歧阈值而记忆保持低于分歧阈值。'
        : '记忆保持高于分歧阈值而掌握读数低于分歧阈值。';
    case 'no_divergence_observed':
      return '两个读数未见跨阈值的背离。';
    case 'partial_coverage':
      return disagreement.missing === 'ability'
        ? '仅记忆保持读数可用，暂无法对比两端。'
        : '仅掌握读数可用，暂无法对比两端。';
    case 'unknown':
      return '暂时无法比较会做与记忆保持。';
  }
}

export function NodeJudgment({
  judgment,
  onDiscussJudgment,
}: {
  judgment: NodeJudgmentReading;
  onDiscussJudgment: () => void;
}) {
  return (
    <section className="kn-judgment" aria-label="当前判断与依据">
      <p className="kn-judgment-text">{judgment.judgement}</p>
      <dl className="kn-judgment-rows">
        <div className="kn-judgment-row">
          <dt className="kn-judgment-term">会做判断</dt>
          <dd className="kn-judgment-value">
            <span className="kn-judgment-claim">
              {ABILITY_CLAIM_LABEL[judgment.ability_claim.kind]}
            </span>
            {abilityClaimNote(judgment.ability_claim) && (
              <span className="kn-judgment-note">{abilityClaimNote(judgment.ability_claim)}</span>
            )}
          </dd>
        </div>
        <div className="kn-judgment-row">
          <dt className="kn-judgment-term">证据时效</dt>
          <dd className="kn-judgment-value">
            {evidenceAgeText(judgment.uncertainty.evidence_age)}
          </dd>
        </div>
        <div className="kn-judgment-row">
          <dt className="kn-judgment-term">两端分歧</dt>
          <dd className="kn-judgment-value">
            {disagreementText(judgment.uncertainty.component_disagreement)}
          </dd>
        </div>
      </dl>
      <p className="kn-judgment-meta">
        评估时点 {new Date(judgment.batch.as_of).toLocaleString('zh-CN')} · {judgment.batch.version}{' '}
        · 未个人校准
      </p>
      <Button variant="ghost" size="sm" onClick={onDiscussJudgment}>
        对此有疑问
      </Button>
    </section>
  );
}

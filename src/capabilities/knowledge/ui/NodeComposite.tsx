// A5 S3 (YUK-354) — NodeComposite 三维折叠（R · p(L) · difficulty）+ TransferList /
// DiagnosticDrill 诚实空态。PORT 自设计源
// docs/design/loom-refresh/project/screen-knowledge-a5.jsx 的 NodeComposite / TransferList /
// DiagnosticDrill。
//
// ⑥治理：三维各走离散档 + 区间 + 来源二态 + 低置信（复用 S1 BandChipView），绝不裸数字。
// 三轴正交：R ⟂ p(L) ⟂ difficulty，同屏并列绝不合并，纯 READ（band 化由 node-dims 纯函数做）。
//
// 诚实空态（忠于冷启设计，不假造）：
//   - TransferList：borrowed-θ 软层（applyKgSoftLayer）是 dark-ship（flag
//     GRAPH_LAPLACIAN_ENABLED / PREREQ_THETA_PROPAGATION_ENABLED 默认 OFF）→ 默认不产
//     transfer 项 → 渲设计的诚实空态。**不强行 wire borrowed-θ**（flag-gated future，
//     接线属后续片）。
//   - DiagnosticDrill（CDM/IRT）：无后端读路径（grep 零命中）→ 渲设计的诚实空态「证据
//     不足 / 低置信」。**不假造 CDM/IRT 数字**（无后端 follow-up）。
//   - MisconceptionList（S4 误区）本片完全不碰。

import { ChevronDown, CircleAlert, Eye, Network } from 'lucide-react';
import { useState } from 'react';
import { A5_BANDS, UNKNOWN_BAND_LABEL } from '@/core/mastery-band';
import { BandChipView } from './BandChip';
import { type NodeThreeDimInput, buildNodeThreeDim } from './node-dims';

// Canonical learner-judgment wire shape. Mirrors the `judgment` field added to
// KnowledgeNodePageResponseSchema (YUK-1587); declared here so the component
// does not depend on the generated API schema, which is regenerated under a
// heavy window. When the generator runs, `node.judgment` satisfies this shape
// structurally.
export interface NodeJudgment {
  ability_claim:
    | { kind: 'low_observed'; rule: { low: number }; calibration: 'uncalibrated' }
    | { kind: 'observed'; rule: { low: number }; calibration: 'uncalibrated' }
    | { kind: 'insufficient_evidence'; reason: string }
    | { kind: 'not_evaluable'; reason: 'knowledge_role_not_mastery_evaluable' }
    | { kind: 'unavailable'; reason: string };
  uncertainty: {
    evidence_age:
      | { kind: 'not_applicable'; reason: string }
      | { kind: 'undated'; reason: 'observed_evidence_without_timestamp' }
      | {
          kind: 'dated';
          idle_days: number;
          freshness: 'fresh' | 'mild' | 'stale';
          growing: boolean;
        };
    component_disagreement:
      | { kind: 'unknown'; reason: string }
      | {
          kind: 'divergence_observed';
          direction: 'ability_high_retention_low' | 'ability_low_retention_high';
          rule: { high: number; low: number };
          calibration: 'uncalibrated';
        }
      | {
          kind: 'no_divergence_observed';
          rule: { high: number; low: number };
          calibration: 'uncalibrated';
        }
      | { kind: 'partial_coverage'; missing: 'ability' | 'retention'; reason: string };
  };
  judgement: string;
  batch: {
    version: 'v0-incumbent';
    calibration: 'uncalibrated';
    as_of: string;
  };
}

export interface NodeCompositeProps {
  /** 焦点节点的三维 RAW 读模型（node-page wire 平铺字段的结构子集）。 */
  input: NodeThreeDimInput;
  /** Canonical learner-judgment projection carried on the same node-page wire. */
  judgment: NodeJudgment;
}

// Canonical ability_claim → honest label. low_observed is 「低掌握读数」, never
// 「不会」: it only means the observed reading sits below the disagreement
// rule's low side.
const ABILITY_CLAIM_LABEL: Record<NodeJudgment['ability_claim']['kind'], string> = {
  low_observed: '掌握读数偏低',
  observed: '掌握读数',
  insufficient_evidence: '证据不足，尚未判断',
  not_evaluable: '此节点不评掌握',
  unavailable: '掌握部件暂不可用',
};

function abilityClaimNote(claim: NodeJudgment['ability_claim']): string | null {
  switch (claim.kind) {
    case 'low_observed':
      return '本人作答读数在低掌握一侧；不等于「不会」，只是现有证据下的判断。';
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

function evidenceAgeText(age: NodeJudgment['uncertainty']['evidence_age']): string {
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
  disagreement: NodeJudgment['uncertainty']['component_disagreement'],
): string {
  switch (disagreement.kind) {
    case 'divergence_observed':
      return disagreement.direction === 'ability_high_retention_low'
        ? '掌握读数高而记忆保持低——可能会了但快忘。'
        : '记忆保持高而掌握读数低——可能记得但不会用。';
    case 'no_divergence_observed':
      return '两个读数未见跨阈值的背离。';
    case 'partial_coverage':
      return disagreement.missing === 'ability'
        ? '仅记忆保持读数可用，暂无法对比两端。'
        : '仅掌握读数可用，暂无法对比两端。';
    case 'unknown':
      return '两端读数均不可用，还不知道。';
  }
}

export function NodeComposite({ input, judgment }: NodeCompositeProps) {
  const [open, setOpen] = useState(false);
  const three = buildNodeThreeDim(input);
  const comp = three.composite;
  const compBand = comp.unknown ? UNKNOWN_BAND_LABEL : A5_BANDS[comp.band];

  return (
    <section className="kn-composite" aria-label="综合掌握状态">
      <div className="kn-composite-head">
        <span className="kn-composite-band">{compBand}</span>
        <span className="kn-composite-cap">综合掌握状态 · 记忆保持 / 理解程度 / 题目难度</span>
      </div>
      <BandChipView view={comp} />

      {three.coldNote && (
        <p className="kn-cold-note">
          <CircleAlert size={15} aria-hidden="true" />
          <span>{three.coldNote}</span>
        </p>
      )}

      <button
        type="button"
        className="kn-disclose un-hit"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={15} aria-hidden="true" className="kn-disclose-chev" />
        {open ? '收起判断依据' : '展开判断依据'}
      </button>

      {open && (
        <>
          <ul className="kn-dims">
            {three.dims.map((d) => (
              <li key={d.key} className="kn-dim">
                <div className="kn-dim-row">
                  <span className="kn-dim-label">{d.label}</span>
                  <BandChipView view={d.view} labels={d.labels} unknownLabel={d.unknownLabel} />
                </div>
                {d.note && <p className="kn-dim-note">{d.note}</p>}
              </li>
            ))}
          </ul>

          {/* YUK-1587 — canonical learner-judgment projection：从同一批
              readLearnerJudgments 的 focal item 投影，只渲已读字段，不新增推断。 */}
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
                    <span className="kn-judgment-note">
                      {abilityClaimNote(judgment.ability_claim)}
                    </span>
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
              评估时点 {new Date(judgment.batch.as_of).toLocaleString('zh-CN')} ·{' '}
              {judgment.batch.version} · 未个人校准
            </p>
          </section>
        </>
      )}
    </section>
  );
}

// ── transfer credit (RT2) — 诚实空态 ──
// borrowed-θ 软层 dark-ship（flag 默认 OFF）→ 当前无 transfer 项可识别。接 borrowed-θ
// 是 flag-gated future（后续片 / flag 翻转后），本片不假造迁移来源。
export function TransferList() {
  return <p className="kn-quiet">目前还没有足够证据判断它受哪些知识点带动。</p>;
}

// ── diagnostic drill-down (CDM 属性画像 / IRT 区分度) — 诚实空态 ──
// 无后端读路径（CDM/IRT 软轨指标尚未热起来）→ 渲设计的诚实空态，不显示假精度。
// 接 CDM/IRT 是无后端 follow-up，本片不假造诊断数字。
export function DiagnosticDrill() {
  const [open, setOpen] = useState(false);
  return (
    <div className="kn-diag" data-open={open}>
      <button
        type="button"
        className="kn-diag-bar"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="kn-diag-ic" aria-hidden="true">
          <Network size={16} />
        </span>
        <span className="kn-diag-text">
          <span className="kn-diag-t">进一步诊断</span>
          <span className="kn-diag-s">作答证据还少，暂不作更细判断</span>
        </span>
        <ChevronDown size={18} aria-hidden="true" className="kn-diag-chev" />
      </button>
      {open && (
        <p className="kn-diag-body">
          <Eye size={16} aria-hidden="true" />
          <span>
            目前没有足够作答证据支持更细的判断。继续练习后，这里会逐步补充；现在不显示看似精确的猜测。
          </span>
        </p>
      )}
    </div>
  );
}

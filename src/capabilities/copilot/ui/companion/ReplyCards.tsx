// Cards a reply places between its paragraphs. Each card shows what the system read for an id; the
// question card is only the frame, because the question and its answering belong to practice.
import { ArrowRight, FileText, ListChecks, LoaderCircle, Network } from 'lucide-react';
import { A5_BANDS } from '@/core/mastery-band';
import type { AbilityClaim, EvidenceAge } from '@/core/schema/learner-judgment';
import type { ApiOperationJsonResponse } from '@/ui/lib/api';
import type { QuestionCardFrameProps } from '../question-card';
import './reply-cards.css';

type KnowledgeCardData = Extract<
  ApiOperationJsonResponse<'getEntityCard'>,
  { entity_kind: 'knowledge'; state: 'ok' }
>;

const ABILITY_CLAIM_LABEL: Record<AbilityClaim['kind'], string> = {
  low_observed: '掌握读数偏低',
  observed: '掌握读数',
  insufficient_evidence: '证据不足，尚未判断',
  not_evaluable: '此节点不评掌握',
  unavailable: '掌握部件暂不可用',
};

function evidenceAgeText(age: EvidenceAge): string {
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

function OpenLabel() {
  return (
    <span className="un-cp-block-open">
      打开
      <ArrowRight size={14} aria-hidden="true" />
    </span>
  );
}

export function KnowledgeCard(p: {
  name: string;
  /** Canonical evidenced ability band; null when the judgment has no usable reading. */
  band: number | null;
  judgment: KnowledgeCardData['judgment'];
  lastPractice: string | null;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="un-cp-block" onClick={p.onOpen}>
      <span className="un-cp-block-kind">
        <Network size={14} aria-hidden="true" />
        知识点
      </span>
      <span className="un-cp-block-title">{p.name}</span>
      {p.judgment ? (
        <>
          <span className="un-cp-block-band">
            会做判断：{ABILITY_CLAIM_LABEL[p.judgment.ability_claim.kind]}
          </span>
          <span className="un-cp-block-note">{p.judgment.judgement}</span>
          <span className="un-cp-block-note">
            证据时效：{evidenceAgeText(p.judgment.uncertainty.evidence_age)}
          </span>
          <span className="un-cp-block-note">
            评估时点{' '}
            <time dateTime={p.judgment.batch.as_of}>
              {new Date(p.judgment.batch.as_of).toLocaleString('zh-CN')}
            </time>
            {p.judgment.batch.calibration === 'uncalibrated' ? ' · 未个人校准' : null}
          </span>
        </>
      ) : (
        <span className="un-cp-block-note">当前判断暂未提供，证据时效与评估时点未知。</span>
      )}
      {!p.judgment || p.band === null ? null : (
        <span className="un-cp-block-band">
          <span className="un-cp-block-meter" aria-hidden="true">
            {A5_BANDS.map((word, index) => (
              <span key={word} data-on={p.band !== null && index <= p.band ? '' : undefined} />
            ))}
          </span>
          {A5_BANDS[p.band]}
        </span>
      )}
      <span className="un-cp-block-foot">
        <span>{p.lastPractice ? `最近一次练习：${p.lastPractice}` : '还没练过'}</span>
        <OpenLabel />
      </span>
    </button>
  );
}

export function NoteCard(p: {
  title: string;
  summary: string;
  updated: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="un-cp-block" onClick={p.onOpen}>
      <span className="un-cp-block-kind">
        <FileText size={14} aria-hidden="true" />
        笔记
      </span>
      <span className="un-cp-block-title">{p.title}</span>
      <span className="un-cp-block-summary">{p.summary}</span>
      <span className="un-cp-block-foot">
        <span>{p.updated}更新</span>
        <OpenLabel />
      </span>
    </button>
  );
}

export function QuestionCard(p: QuestionCardFrameProps) {
  if (p.gone) return <div className="un-cp-block un-cp-block-gone">{p.gone}</div>;
  return (
    <section className="un-cp-block un-cp-block-question" aria-label="题目">
      <p className="un-cp-block-kind">
        <ListChecks size={14} aria-hidden="true" />
        题目
        {p.status ? (
          <span className="un-cp-block-status" role="status" data-tone={p.status.tone}>
            {p.status.tone === 'waiting' ? (
              <LoaderCircle size={14} aria-hidden="true" className="un-cp-spin" />
            ) : null}
            {p.status.word}
          </span>
        ) : null}
      </p>
      {p.children}
      {p.note ? <p className="un-cp-block-note">{p.note}</p> : null}
      {p.actions ? <div className="un-cp-block-actions">{p.actions}</div> : null}
    </section>
  );
}

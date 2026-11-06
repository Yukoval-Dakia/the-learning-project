// Cards a reply places between its paragraphs. Each card shows what the system read for an id; the
// question card takes its answer area as `children`, because the blocks belong to the practice page.
import { ArrowRight, FileText, ListChecks, LoaderCircle, Network } from 'lucide-react';
import type { ReactNode } from 'react';
import { A5_BANDS, UNKNOWN_BAND_LABEL } from '@/core/mastery-band';
import './reply-cards.css';

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
  /** Index into the mastery bands; null when there is no evidence yet. */
  band: number | null;
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
      <span className="un-cp-block-band">
        <span className="un-cp-block-meter" aria-hidden="true">
          {A5_BANDS.map((word, index) => (
            <span key={word} data-on={p.band !== null && index <= p.band ? '' : undefined} />
          ))}
        </span>
        {p.band === null ? UNKNOWN_BAND_LABEL : A5_BANDS[p.band]}
      </span>
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

export function QuestionCard(p: {
  /** Still being checked: the question reads, answering waits. */
  checking: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="un-cp-block un-cp-block-question" aria-label="题目">
      <p className="un-cp-block-kind">
        <ListChecks size={14} aria-hidden="true" />
        题目
        {p.checking ? (
          <span className="un-cp-block-status" role="status">
            <LoaderCircle size={14} aria-hidden="true" className="un-cp-spin" />
            还在检查
          </span>
        ) : null}
      </p>
      {p.children}
      {p.checking ? (
        <p className="un-cp-block-note">检查完就能在这里作答。</p>
      ) : p.actions ? (
        <div className="un-cp-block-actions">{p.actions}</div>
      ) : null}
    </section>
  );
}

export function GoneCard({ what }: { what: string }) {
  return <div className="un-cp-block un-cp-block-gone">这{what}已经不在了。</div>;
}

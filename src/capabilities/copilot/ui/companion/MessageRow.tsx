// One turn in the conversation. The learner's line sits right in a quiet bubble; the companion's
// reply is plain prose with its steps above it and what it produced below it. A reply is one
// element from the first word to settled: while it streams it is lighter, with a caret and
// 「生成中 · 还未生效」; the terminal Markdown then replaces the draft in place (C3).
// Memoized: a streaming delta rebuilds only the growing message, so settled rows skip re-rendering.

import { memo } from 'react';
import { DeferredMarkdownRenderer } from '@/ui/lib/deferred-markdown-renderer';
import { Chip } from '@/ui-next/public';
import type { ChatMessage } from '../message-projection';
import { HeroBlock } from './HeroBlock';
import { ProposalNotice } from './ProposalNotice';
import { splitProposalDisclosure } from './proposal-disclosure';
import { SkillTurnBlock } from './SkillTurnBlock';
import { StepList, stepsOf } from './ToolRow';

export interface MessageRowProps {
  message: ChatMessage;
  /** 1-based number of this reply among the companion's replies (for 「更正第 N 轮」). */
  turnNumber?: number;
  correctionSelected: boolean;
  revertPending: boolean;
  chipPending: boolean;
  chipAcked: boolean;
  navigate: (to: string) => void;
  onSelectCorrection: (turnId: string, turnNumber: number) => void;
  onRevert: (checkpointEventId: string) => void;
  onAcceptCorrective: (sessionId: string, questionId: string, replyEventId?: string) => void;
}

function UserRow({ message }: { message: ChatMessage }) {
  return (
    <div className="un-cp-row un-cp-row-user">
      {message.derivation_policy === 'answer_only' && !message.idempotency_key ? (
        <Chip>仅用于本次回答</Chip>
      ) : null}
      <div className="un-cp-bubble">{message.text}</div>
    </div>
  );
}

export const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const { message: m } = props;
  if (m.role === 'user') return <UserRow message={m} />;
  if (m.role === 'tombstone') {
    return <p className="un-cp-row un-cp-row-tombstone">{m.text}</p>;
  }
  const { text, pending } = splitProposalDisclosure(m.text);
  const settled = !m.streaming;
  const turnId = m.reply_event_id;
  const canCorrect = settled && turnId !== undefined && props.turnNumber !== undefined;
  const checkpoint = settled ? m.checkpoint_event_id : undefined;
  return (
    <div className="un-cp-row un-cp-row-ai" data-streaming={m.streaming ? '' : undefined}>
      <StepList steps={stepsOf(m)} />
      <DeferredMarkdownRenderer className="un-cp-md un-cp-reply">{text}</DeferredMarkdownRenderer>
      {m.streaming ? (
        <p className="un-cp-reply-meta" aria-live="off">
          <span className="un-cp-caret" aria-hidden="true" />
          生成中 · 还未生效
        </p>
      ) : null}
      <SkillTurnBlock
        message={m}
        chipPending={props.chipPending}
        chipAcked={props.chipAcked}
        onAcceptCorrective={props.onAcceptCorrective}
      />
      {m.primary_view ? <HeroBlock view={m.primary_view} navigate={props.navigate} /> : null}
      {settled ? <ProposalNotice pending={pending} navigate={props.navigate} /> : null}
      {canCorrect || checkpoint ? (
        <div className="un-cp-row-actions">
          {canCorrect && turnId ? (
            <button
              type="button"
              className="un-cp-text-btn un-hit"
              aria-pressed={props.correctionSelected}
              onClick={() => props.onSelectCorrection(turnId, props.turnNumber ?? 0)}
            >
              更正这轮
            </button>
          ) : null}
          {checkpoint ? (
            <button
              type="button"
              className="un-cp-text-btn un-hit"
              disabled={props.revertPending}
              onClick={() => props.onRevert(checkpoint)}
            >
              {props.revertPending ? '撤回中…' : '撤回本轮更改'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

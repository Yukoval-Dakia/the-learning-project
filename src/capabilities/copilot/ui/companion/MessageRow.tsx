import type { NotePageClient } from '@/capabilities/notes/ui-public';
import type { ConfirmationAssessmentRenderer } from '../confirmation';
import { ConfirmationBlock } from './ConfirmationBlock';
import type { ConfirmationAction } from './turn-sender';
// One turn in the conversation. The learner's line sits right in a quiet bubble; the companion's
// reply is plain prose with its steps above it and what it produced below it. A reply is one
// element from the first word to settled. The caret describes reply generation only;
// it cannot establish whether any tool operation has already taken effect.
// Memoized: a streaming delta rebuilds only the growing message, so settled rows skip re-rendering.

import { memo } from 'react';
import { Chip } from '@/ui-next/public';
import { type ChatMessage, composeStreamingReply } from '../message-projection';
import { publicProseFailureBadge, publicProseStatusText } from '../public-prose';
import { ConversationMarkdown } from './ConversationMarkdown';
import { HeroBlock } from './HeroBlock';
import { ProposalNotice } from './ProposalNotice';
import { splitProposalDisclosure } from './proposal-disclosure';
import { SkillTurnBlock } from './SkillTurnBlock';
import { StepActivity, stepsOf } from './ToolRow';

export interface MessageRowProps {
  confirmationRenderer?: ConfirmationAssessmentRenderer;
  readNotePage: NotePageClient;
  showConfirmation?: boolean;
  confirmationDisabled?: boolean;
  onConfirmation?: (action: ConfirmationAction) => Promise<void>;
  onRefreshConfirmation?: () => void;
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
  const canonical = splitProposalDisclosure(m.text);
  const publicProse = m.public_prose;
  const incomplete = publicProse?.status === 'failed' || publicProse?.status === 'interrupted';
  // Successful terminal text retains its sealed corrections and disclosures.
  const body =
    incomplete || publicProse?.status === 'streaming' ? publicProse.text : canonical.text;
  const generationStatus = publicProse ? publicProseStatusText(publicProse) : undefined;
  // A sealed help exit completes with its exit copy as the body; the badge says why it exited.
  const failureBadge = publicProse ? publicProseFailureBadge(publicProse) : undefined;
  const generating = m.streaming || publicProse?.status === 'streaming';
  // YUK-1548 §5 — while streaming, pictures being drawn stand in the text at their stream position;
  // once settled the reply's own fences are the only source, so a reload renders the same thing.
  const shown = generating ? composeStreamingReply(body, m.stream_blocks) : body;
  const steps = stepsOf(m);
  const settled = !generating;
  const turnId = m.reply_event_id;
  const canCorrect = settled && turnId !== undefined && props.turnNumber !== undefined;
  const checkpoint = settled ? m.checkpoint_event_id : undefined;
  return (
    <div className="un-cp-row un-cp-row-ai" data-streaming={generating ? '' : undefined}>
      {/* YUK-1664 — settled: the reply's steps fold into one summary line above the text. */}
      {settled ? <StepActivity steps={steps} live={false} /> : null}
      <ConversationMarkdown className="un-cp-md un-cp-reply">{shown}</ConversationMarkdown>
      {failureBadge ? (
        <p className="un-cp-reply-badge">
          <Chip tone="caution">{failureBadge}</Chip>
        </p>
      ) : null}
      {incomplete ? (
        <p className="un-cp-reply-status" role="status">
          {generationStatus}
        </p>
      ) : generating ? (
        // YUK-1664 — while generating, one status line under the text says what is happening now
        // (text and tool steps interleave, so it stays until the reply settles).
        <StepActivity steps={steps} live hasText={Boolean(body?.trim())} />
      ) : null}
      {m.confirmationIncompatible && <p role="alert">确认题版本或状态不兼容，暂不能操作。</p>}
      {props.showConfirmation &&
        m.confirmation &&
        props.onConfirmation &&
        props.onRefreshConfirmation && (
          <ConfirmationBlock
            key={`${m.confirmation.occurrence.occurrence_id}:${m.confirmation.occurrence.state}:${m.confirmation.assessment && typeof m.confirmation.assessment === 'object' && 'submission' in m.confirmation.assessment && m.confirmation.assessment.submission ? 'recorded' : 'unsubmitted'}`}
            confirmation={m.confirmation}
            renderer={props.confirmationRenderer}
            disabled={props.confirmationDisabled ?? true}
            onCommand={props.onConfirmation}
            onRefresh={props.onRefreshConfirmation}
          />
        )}
      <SkillTurnBlock
        message={m}
        chipPending={props.chipPending}
        chipAcked={props.chipAcked}
        onAcceptCorrective={props.onAcceptCorrective}
      />
      {m.primary_view ? (
        <HeroBlock
          view={m.primary_view}
          navigate={props.navigate}
          readNotePage={props.readNotePage}
        />
      ) : null}
      {settled ? <ProposalNotice pending={canonical.pending} navigate={props.navigate} /> : null}
      {canCorrect || checkpoint ? (
        <details className="un-st-message-operations">
          <summary>本轮操作</summary>
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
        </details>
      ) : null}
    </div>
  );
});

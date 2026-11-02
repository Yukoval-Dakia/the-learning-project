import type { NotePageClient } from '@/capabilities/notes/ui-public';
import type { ConfirmationAssessmentRenderer } from '../confirmation';
import { conversationReady } from './companion-state';
// The scrolling conversation: today's summary on top (open while the conversation is empty), then
// every turn. The scroller keeps the newest line in view while the reader is at the bottom.

import type { CompanionController } from './companion-controller';
import { MessageRow } from './MessageRow';
import { SummaryCard } from './SummaryCard';
import type { StickToBottom } from './stick-to-bottom';
import { useCompanion } from './use-companion';

export interface MessageStreamProps {
  confirmationRenderer?: ConfirmationAssessmentRenderer;
  readNotePage: NotePageClient;
  controller: CompanionController;
  stick: StickToBottom;
  navigate: (to: string) => void;
}

export function MessageStream({
  controller,
  stick,
  navigate,
  confirmationRenderer,
  readNotePage,
}: MessageStreamProps) {
  const messages = useCompanion(controller, (s) => s.messages);
  const correctionTurnId = useCompanion(controller, (s) => s.correctionTarget?.turnId ?? null);
  const revertPendingId = useCompanion(controller, (s) => s.revertPendingId);
  const chipPending = useCompanion(controller, (s) => s.chipPending);
  const chipAcked = useCompanion(controller, (s) => s.chipAcked);
  const disabled = useCompanion(
    controller,
    (s) =>
      !conversationReady(s) ||
      s.derivationPolicy !== 'allow' ||
      !!s.correctionTarget ||
      s.pendingTurns.some((t) => t.requestBody.session_id === s.currentSessionId) ||
      s.runs.some(
        (r) =>
          r.sessionId === s.currentSessionId && r.phase !== 'completed' && r.phase !== 'failed',
      ),
  );
  const firstOccurrence = new Map<string, string>();
  const latestSequence = new Map<string, number>();
  for (const m of messages) {
    const o = m.confirmation?.occurrence;
    if (o) {
      if (!firstOccurrence.has(o.occurrence_id)) firstOccurrence.set(o.occurrence_id, m.id);
      latestSequence.set(
        o.occurrence_id,
        Math.max(latestSequence.get(o.occurrence_id) ?? -1, o.sequence),
      );
    }
  }
  const { actions } = controller;
  let replies = 0;
  return (
    <div className="un-cp-scroll" ref={stick.attach}>
      <div className="un-cp-stream">
        <SummaryCard empty={messages.length === 0} navigate={navigate} />
        {messages.map((message) => {
          if (message.role === 'ai') replies += 1;
          const questionId = message.skill_turn?.structured_question?.id;
          return (
            <MessageRow
              key={message.id}
              message={message}
              confirmationRenderer={confirmationRenderer}
              readNotePage={readNotePage}
              showConfirmation={
                !!message.confirmation &&
                firstOccurrence.get(message.confirmation.occurrence.occurrence_id) === message.id
              }
              confirmationDisabled={
                disabled ||
                (!!message.confirmation &&
                  message.confirmation.occurrence.sequence !==
                    latestSequence.get(message.confirmation.occurrence.occurrence_id))
              }
              onConfirmation={(action) =>
                message.confirmation
                  ? controller.sender.sendConfirmation(message.confirmation.occurrence, action)
                  : Promise.resolve()
              }
              onRefreshConfirmation={() =>
                void controller.runs.refetchTurns().catch(() =>
                  controller.store.setState({
                    refreshFailed: true,
                    error: '确认题记录读取失败，请重试读取。',
                  }),
                )
              }
              turnNumber={message.role === 'ai' ? replies : undefined}
              correctionSelected={
                message.reply_event_id !== undefined && message.reply_event_id === correctionTurnId
              }
              revertPending={
                message.checkpoint_event_id !== undefined &&
                message.checkpoint_event_id === revertPendingId
              }
              chipPending={questionId !== undefined && questionId === chipPending}
              chipAcked={questionId !== undefined && questionId === chipAcked}
              navigate={navigate}
              onSelectCorrection={actions.selectCorrection}
              onRevert={actions.revert}
              onAcceptCorrective={actions.acceptCorrectiveChip}
            />
          );
        })}
      </div>
    </div>
  );
}

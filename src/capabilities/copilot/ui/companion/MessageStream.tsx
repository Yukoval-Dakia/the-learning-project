// The scrolling conversation: today's summary on top (open while the conversation is empty), then
// every turn. The scroller keeps the newest line in view while the reader is at the bottom.

import type { CompanionController } from './companion-controller';
import { MessageRow } from './MessageRow';
import { SummaryCard } from './SummaryCard';
import type { StickToBottom } from './stick-to-bottom';
import { useCompanion } from './use-companion';

export interface MessageStreamProps {
  controller: CompanionController;
  stick: StickToBottom;
  navigate: (to: string) => void;
}

export function MessageStream({ controller, stick, navigate }: MessageStreamProps) {
  const messages = useCompanion(controller, (s) => s.messages);
  const correctionTurnId = useCompanion(controller, (s) => s.correctionTarget?.turnId ?? null);
  const revertPendingId = useCompanion(controller, (s) => s.revertPendingId);
  const chipPending = useCompanion(controller, (s) => s.chipPending);
  const chipAcked = useCompanion(controller, (s) => s.chipAcked);
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

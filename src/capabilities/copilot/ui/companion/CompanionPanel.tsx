// The companion's frame, in three layouts:
//   side  — desktop: a column beside the content (the shell gives it its place), not glass (T3);
//   float — iPad: a glass layer floating over the page, the page stays usable;
//   sheet — phone: a full-height sheet over a scrim, focus kept inside, Esc or the scrim closes.
// Mounting the panel starts a visit (a fresh session read); unmounting ends it, which only
// detaches progress streams — runs keep going on the server.

import {
  GraduationCap,
  History,
  Maximize2,
  Minimize2,
  PanelRightClose,
  SquarePen,
  X,
} from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { IconButton, UiNextRoot } from '@/ui-next/public';
import type { UseCopilotNudgesResult } from '../useCopilotNudges';
import { Composer } from './Composer';
import { ContextBar } from './ContextBar';
import { ConversationList } from './ConversationList';
import type { CompanionController } from './companion-controller';
import { conversationReady, isThinking } from './companion-state';
import { MessageStream } from './MessageStream';
import { NudgeBar } from './NudgeBar';
import { RunFooter } from './RunFooter';
import { useStickToBottom } from './stick-to-bottom';
import { useCompanion } from './use-companion';
import './companion.css';

export type CompanionLayout = 'side' | 'float' | 'sheet';

export interface CompanionPanelProps {
  controller: CompanionController;
  layout: CompanionLayout;
  onClose: () => void;
  navigate: (to: string) => void;
  nudges: UseCopilotNudgesResult;
  /** Show this conversation when the panel opens (or when this value changes while open). */
  sessionId?: string | null;
}

const TEACH_PROMPT = '我想进入教学模式，请带我一步步学习当前内容';

/** Phone sheet: the page underneath must not scroll while the sheet is up. */
function lockBodyScroll(node: HTMLElement | null) {
  if (!node) return undefined;
  const previous = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => {
    document.body.style.overflow = previous;
  };
}

export function CompanionPanel({
  controller,
  layout,
  onClose,
  navigate,
  nudges,
  sessionId,
}: CompanionPanelProps) {
  const [wide, setWide] = useState(false);
  const listId = useId();
  const stick = useStickToBottom();
  const listOpen = useCompanion(controller, (s) => s.listOpen);
  const ready = useCompanion(controller, conversationReady);
  const thinking = useCompanion(controller, isThinking);
  const trapRef = useFocusTrap(layout === 'sheet', onClose);
  const { sessions, sender, actions } = controller;

  // The panel's own node owns the visit: attach opens it, detach closes it.
  const attachVisit = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return undefined;
      sessions.openVisit();
      return () => sessions.closeVisit();
    },
    [sessions],
  );
  // Keyed by sessionId below, so a new requested conversation re-runs this once.
  const showRequested = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !sessionId) return;
      if (controller.store.getState().currentSessionId !== sessionId) {
        sessions.selectConversation(sessionId);
      }
    },
    [controller, sessions, sessionId],
  );
  const focusOnOpen = useCallback(
    (node: HTMLElement | null) => {
      if (layout !== 'sheet') node?.focus({ preventScroll: true });
    },
    [layout],
  );

  const CloseIcon = layout === 'side' ? PanelRightClose : X;
  return (
    <UiNextRoot
      ref={attachVisit}
      className="un-cp-root"
      data-un-m3e="companion-content"
      data-layout={layout}
    >
      {layout === 'sheet' ? (
        <button
          type="button"
          ref={lockBodyScroll}
          tabIndex={-1}
          aria-label="收起学习伙伴"
          className="un-cp-scrim"
          onClick={onClose}
        />
      ) : null}
      <section
        ref={layout === 'sheet' ? trapRef : focusOnOpen}
        className={layout === 'float' ? 'un-cp un-glass' : 'un-cp'}
        data-layout={layout}
        data-wide={wide ? '' : undefined}
        {...(layout === 'sheet'
          ? { role: 'dialog', 'aria-modal': true }
          : { role: 'complementary' })}
        aria-label="学习伙伴"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && layout !== 'sheet' && !listOpen) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {sessionId ? <span hidden key={sessionId} ref={showRequested} /> : null}
        <header className="un-cp-head">
          {layout === 'sheet' ? <span className="un-cp-grip" aria-hidden="true" /> : null}
          <div className="un-cp-title">
            <span
              className="un-cp-mark"
              data-thinking={thinking ? '' : undefined}
              aria-hidden="true"
            />
            <h2 className="un-cp-name">学习伙伴</h2>
            <span className="un-cp-state" aria-live="polite">
              {thinking ? '在想…' : '在这里'}
            </span>
          </div>
          <div className="un-cp-head-actions">
            <IconButton
              label={listOpen ? '收起对话记录' : '对话记录'}
              icon={<History size={16} />}
              aria-expanded={listOpen}
              aria-controls={listOpen ? listId : undefined}
              onClick={() => actions.setListOpen(!listOpen)}
            />
            <IconButton
              label="新对话"
              icon={<SquarePen size={16} />}
              onClick={() => void sessions.createConversation()}
            />
            <IconButton
              label="教学模式：一步步带我学"
              icon={<GraduationCap size={16} />}
              disabled={!ready}
              onClick={() => {
                stick.stick();
                void sender.send(TEACH_PROMPT);
              }}
            />
            {layout === 'sheet' ? null : (
              <IconButton
                label={wide ? '恢复宽度' : '加宽'}
                icon={wide ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                aria-pressed={wide}
                onClick={() => setWide((value) => !value)}
              />
            )}
            <IconButton label="收起学习伙伴" icon={<CloseIcon size={16} />} onClick={onClose} />
          </div>
        </header>
        <ContextBar />
        <NudgeBar nudges={nudges} />
        <div className="un-cp-body">
          <MessageStream controller={controller} stick={stick} navigate={navigate} />
          {listOpen ? <ConversationList controller={controller} id={listId} /> : null}
        </div>
        <footer className="un-cp-foot">
          <RunFooter controller={controller} />
          <Composer controller={controller} stick={stick} />
        </footer>
      </section>
    </UiNextRoot>
  );
}

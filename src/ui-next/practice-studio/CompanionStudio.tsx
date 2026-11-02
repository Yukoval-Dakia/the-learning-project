import {
  ArrowUp,
  GraduationCap,
  History,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Plus,
  X,
} from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useId } from 'react';
import { ToolButton } from './controls';
import './studio.css';
import './renderers.css';

export function CompanionStudio(p: {
  layout: 'side' | 'float' | 'sheet';
  wide: boolean;
  historyOpen: boolean;
  historyId: string;
  ready: boolean;
  thinking: boolean;
  surfaceRef: Ref<HTMLElement>;
  onClose(): void;
  onHistory(): void;
  onNew(): void;
  onTeach(): void;
  onWide(): void;
  requestedSession: ReactNode;
  context: ReactNode;
  nudges: ReactNode;
  messages: ReactNode;
  history: ReactNode;
  runStatus: ReactNode;
  composer: ReactNode;
}) {
  const title = useId();
  return (
    <aside
      className="un-st-support"
      ref={p.surfaceRef}
      tabIndex={-1}
      data-layout={p.layout}
      data-wide={p.wide || undefined}
      {...(p.layout === 'sheet'
        ? { role: 'dialog', 'aria-modal': true }
        : { role: 'complementary' })}
      aria-labelledby={title}
      onKeyDown={(event) => {
        // The background practice hotkeys are window listeners; an auxiliary pane owns its input.
        if (
          /^[1-9]$/.test(event.key) ||
          ((event.ctrlKey || event.metaKey) && event.key === 'Enter')
        )
          event.stopPropagation();
        if (
          event.key === 'Escape' &&
          !event.nativeEvent.isComposing &&
          p.layout !== 'sheet' &&
          !p.historyOpen
        ) {
          event.stopPropagation();
          p.onClose();
        }
      }}
    >
      {p.requestedSession}
      <header className="un-st-support-heading">
        <div>
          <span className="un-st-eyebrow">一起思考</span>
          <h2 id={title}>学习伙伴</h2>
        </div>
        <ToolButton label="收起学习伙伴" onClick={p.onClose}>
          {p.layout === 'side' ? <PanelRightClose size={22} /> : <X size={22} />}
        </ToolButton>
      </header>
      <div className="un-st-support-toolbar">
        <button
          type="button"
          className="un-st-button un-st-text"
          aria-expanded={p.historyOpen}
          aria-controls={p.historyOpen ? p.historyId : undefined}
          onClick={p.onHistory}
        >
          <History size={19} />
          对话记录
        </button>
        <div>
          <ToolButton label="新对话" onClick={p.onNew}>
            <Plus size={21} />
          </ToolButton>
          <ToolButton label="一步步带我学" disabled={!p.ready} onClick={p.onTeach}>
            <GraduationCap size={21} />
          </ToolButton>
          {p.layout !== 'sheet' && (
            <ToolButton
              label={p.wide ? '恢复宽度' : '加宽阅读区'}
              aria-pressed={p.wide}
              onClick={p.onWide}
            >
              {p.wide ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
            </ToolButton>
          )}
        </div>
      </div>
      <div className="un-st-support-context">
        {p.context}
        {p.nudges}
      </div>
      <div className="un-st-support-body">
        {p.messages}
        {p.history}
      </div>
      <footer className="un-st-support-footer">
        {p.runStatus}
        {p.composer}
      </footer>
    </aside>
  );
}

export function StudioComposer(p: {
  draft: string;
  ready: boolean;
  canSend: boolean;
  policy: string;
  policyOptions: readonly { value: string; label: string }[];
  policyNote?: string;
  correction?: { turn: number; clear(): void };
  suggestions: readonly { label: string; run(): void }[];
  onDraft(value: string): void;
  onPolicy(value: string): void;
  onSend(): void;
}) {
  const policyId = useId();
  return (
    <div className="un-st-composer">
      {p.correction && (
        <div className="un-st-correction">
          <span>更正第 {p.correction.turn} 轮</span>
          <ToolButton label="取消更正" onClick={p.correction.clear}>
            <X size={18} />
          </ToolButton>
        </div>
      )}
      {!!p.suggestions.length && (
        <details className="un-st-prompt-options">
          <summary>可继续讨论</summary>
          <div>
            {p.suggestions.map((action) => (
              <button type="button" key={action.label} disabled={!p.ready} onClick={action.run}>
                {action.label}
              </button>
            ))}
          </div>
        </details>
      )}
      <div className="un-st-compose-input">
        <label>
          你的问题
          <textarea
            rows={3}
            maxLength={4000}
            value={p.draft}
            disabled={!p.ready}
            data-companion-composer=""
            placeholder={p.ready ? '写下思路，或引用题目中的一段…' : '正在准备对话…'}
            onChange={(event) => p.onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (p.canSend) p.onSend();
              }
            }}
          />
        </label>
        <div className="un-st-compose-send">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <ToolButton label="发送消息" disabled={!p.canSend} onClick={p.onSend}>
            <ArrowUp size={22} />
          </ToolButton>
        </div>
      </div>
      <fieldset className="un-st-policy">
        <legend>本轮用途</legend>
        {p.policyOptions.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={policyId}
              checked={p.policy === option.value}
              onChange={() => p.onPolicy(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      {p.policyNote && (
        <p className="un-st-policy-note" role="status">
          {p.policyNote}
        </p>
      )}
    </div>
  );
}

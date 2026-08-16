import { LoomIcon } from '@/ui/primitives/LoomIcon';

export interface CopilotSessionListItem {
  id: string;
  status: string;
  title: string;
  updated_at: string;
}

interface CopilotSessionPanelProps {
  sessions: CopilotSessionListItem[];
  currentSessionId: string | null;
  creating: boolean;
  disabled?: boolean;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
}

export function CopilotSessionPanel({
  sessions,
  currentSessionId,
  creating,
  disabled = false,
  onSelect,
  onCreate,
}: CopilotSessionPanelProps) {
  return (
    <section
      aria-label="Copilot 对话"
      data-testid="copilot-session-panel"
      className="flex max-h-[240px] flex-col gap-[8px] border-b border-[var(--line-soft)] pb-[10px]"
    >
      <div className="flex items-center justify-between gap-[8px]">
        <div className="flex items-center gap-[6px] text-[12px] font-medium text-[var(--ink-2)]">
          <LoomIcon name="history" size={14} />
          对话记录
        </div>
        <button
          type="button"
          className="chip inline-flex items-center gap-[4px]"
          disabled={disabled || creating}
          onClick={onCreate}
        >
          <LoomIcon name="plus" size={13} />
          {creating ? '创建中…' : '新对话'}
        </button>
      </div>
      <ul className="flex flex-col gap-[4px] overflow-y-auto">
        {sessions.map((session) => {
          const selected = session.id === currentSessionId;
          return (
            <li key={session.id}>
              <button
                type="button"
                aria-current={selected ? 'true' : undefined}
                disabled={disabled || selected}
                onClick={() => onSelect(session.id)}
                className={[
                  'flex w-full items-center gap-[8px] rounded-[var(--r-2)] px-[8px] py-[7px] text-left',
                  'transition-colors duration-[var(--dur-fast)]',
                  selected
                    ? 'bg-[var(--coral-soft)] text-[var(--coral-ink)]'
                    : 'text-[var(--ink-2)] hover:bg-[var(--paper-sunk)]',
                ].join(' ')}
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{session.title}</span>
                <time className="shrink-0 text-[11px] text-[var(--ink-4)]">
                  {new Date(session.updated_at).toLocaleDateString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                  })}
                </time>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

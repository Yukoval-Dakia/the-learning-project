import { useCallback, useRef } from 'react';
import type { ReactNode, Ref } from 'react';
import type { WorkspaceProps } from './contracts';
import { ReadingWorkspace } from './ReadingWorkspace';
import { CompanionWorkspace } from './CompanionWorkspace';
import { ActionButton, Icon, IconButton, NoticeView } from './controls';
import './workspace.css';
function assign<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') return ref(node);
  if (ref) ref.current = node;
}
function Modal({
  children,
  label,
  close,
  lifecycle,
  blocked,
  sheet = false,
}: {
  children: ReactNode;
  label: string;
  close(): void;
  lifecycle: Ref<HTMLDialogElement>;
  blocked: boolean;
  sheet?: boolean;
}) {
  const mount = useCallback(
    (node: HTMLDialogElement | null) => {
      if (!node) return;
      const previous = node.ownerDocument.activeElement;
      const cleanup = assign(lifecycle, node);
      node.showModal();
      return () => {
        node.close();
        if (typeof cleanup === 'function') cleanup();
        else assign(lifecycle, null);
        if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      };
    },
    [lifecycle],
  );
  return (
    <dialog
      className={sheet ? 'un-pw-modal un-pw-sheet' : 'un-pw-modal'}
      aria-label={label}
      ref={mount}
      onCancel={(e) => {
        e.preventDefault();
        if (!blocked) close();
      }}
    >
      {children}
    </dialog>
  );
}
export function PracticeWorkspace(p: WorkspaceProps) {
  const { view: v, intents: i } = p;
  const trigger = useRef<HTMLButtonElement>(null);
  const closeCompanion = () => {
    i.companionOpen(false);
    trigger.current?.focus();
  };
  const triggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      trigger.current = node;
      return assign(p.lifecycle?.companionTriggerRef, node);
    },
    [p.lifecycle?.companionTriggerRef],
  );
  const themeLabel = v.theme === 'light' ? '当前浅色，切换为深色' : '当前深色，切换为浅色';
  return (
    <div
      className="un-pw"
      data-theme={v.theme}
      data-companion={v.companion.open && p.presentation.companionMode === 'docked'}
    >
      <a className="un-pw-skip" href="#un-pw-main">
        跳到题目
      </a>
      <header className="un-pw-appbar">
        <ActionButton action={v.back} onAction={i.action} icon={<Icon name="back" />} />
        <nav aria-label={v.navigation.label}>
          <details>
            <summary>
              {v.navigation.items.find((n) => n.current)?.action.label ?? v.navigation.label}
              <span aria-hidden="true"> ▾</span>
            </summary>
            <ul className="un-pw-nav-list">
              {v.navigation.items.map((n) => (
                <li key={n.id} aria-current={n.current ? 'page' : undefined}>
                  <ActionButton action={n.action} onAction={i.action} />
                </li>
              ))}
            </ul>
          </details>
        </nav>
        <div className="un-pw-tools">
          <IconButton
            label={themeLabel}
            onClick={() => i.theme(v.theme === 'light' ? 'dark' : 'light')}
          >
            <Icon name={v.theme === 'light' ? 'moon' : 'sun'} />
          </IconButton>
          <button
            type="button"
            ref={triggerRef}
            className="un-pw-partner-trigger"
            aria-expanded={v.companion.open}
            aria-controls="un-pw-partner"
            onClick={() => i.companionOpen(!v.companion.open)}
          >
            <Icon name="partner" />
            <span>学习伙伴</span>
          </button>
        </div>
      </header>
      <div className="un-pw-layout">
        <main id="un-pw-main" tabIndex={-1} ref={p.lifecycle?.contentRef}>
          <ReadingWorkspace props={p} />
          {v.feedback && <NoticeView notice={v.feedback} onAction={i.action} />}
        </main>
        {v.companion.open &&
          (p.presentation.companionMode === 'docked' ? (
            <div id="un-pw-partner" className="un-pw-dock">
              <CompanionWorkspace props={p} close={closeCompanion} />
            </div>
          ) : (
            <Modal
              sheet
              label="学习伙伴"
              lifecycle={p.presentation.modalRef}
              blocked={!!v.blocking || p.presentation.externalModalOpen}
              close={closeCompanion}
            >
              <div id="un-pw-partner">
                <CompanionWorkspace props={p} close={closeCompanion} />
              </div>
            </Modal>
          ))}
      </div>
      {v.blocking && (
        <Modal
          key={v.blocking.id}
          label={v.blocking.title}
          lifecycle={p.presentation.modalRef}
          blocked={p.presentation.externalModalOpen}
          close={() => i.dismissBlocking(v.blocking!.id)}
        >
          <h2>{v.blocking.title}</h2>
          <p>{v.blocking.body}</p>
          <div className="un-pw-actions">
            <button
              className="un-pw-action"
              type="button"
              onClick={() => i.dismissBlocking(v.blocking!.id)}
            >
              {v.blocking.cancelLabel}
            </button>
            <ActionButton primary action={v.blocking.confirm} onAction={i.action} />
          </div>
        </Modal>
      )}
      {p.surfaces?.overlays}
      <div className="un-pw-sr" role="status" aria-live="polite" aria-atomic="true">
        {v.announcement}
      </div>
    </div>
  );
}

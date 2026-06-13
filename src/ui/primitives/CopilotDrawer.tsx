// Wave 5 / T-D3/A — generic Copilot Drawer primitive.
//
// Slot-based slide-out panel for the global Copilot Dock (mounted app-wide in
// (app)/layout.tsx — AF S2a; previously page-scoped, now global). Two slots:
//   • summary  — Coach TodayPlan.daily_focus + review_due + dreaming preview
//   • chat     — message list + tool-use cards + composer
//
// RTL slide-in (from the right). ESC + outside-click close. Open state is
// controlled by the parent (dwell hook flips it). The primitive intentionally
// does no data fetching — keeps T-D3/A reusable.

'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { IconBtn } from './IconBtn';
import { LoomIcon, type LoomIconName } from './LoomIcon';

export interface CopilotDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Head icon shown in the coral .card-icon.accent badge (copilot.jsx L106). */
  icon?: LoomIconName;
  /** Badge slot rendered right after the title — e.g. an 在线 status badge. */
  headBadge?: ReactNode;
  /** Extra head action buttons in the right cluster, before the close button. */
  headActions?: ReactNode;
  /** Render the maximize/minimize width toggle in the head. Defaults to true. */
  expandable?: boolean;
  /** Summary slot rendered at the top of the drawer body. */
  summary?: ReactNode;
  /** Chat slot rendered below the summary; usually scrollable. */
  children?: ReactNode;
  /** Footer slot for the composer / input. */
  footer?: ReactNode;
  /** Optional aria-label override; defaults to title or 'Copilot 抽屉'. */
  ariaLabel?: string;
}

export function CopilotDrawer({
  open,
  onClose,
  title = 'Copilot',
  icon = 'copilot',
  headBadge,
  headActions,
  expandable = true,
  summary,
  children,
  footer,
  ariaLabel,
}: CopilotDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 全屏 Copilot（copilot.jsx L109 maximize）= 宽度切换的纯 chrome 状态：
  // 默认 420px 侧栏 ↔ 展开 min(900px, 92vw) 的宽读模式。每次关闭复位回窄，
  // 让下次打开从默认宽度起。
  const [expanded, setExpanded] = useState(false);

  // ESC closes the drawer.
  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll while drawer is open (mobile UX).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus the panel on open (basic focus handoff; Wave 5 doesn't ship a
  // full focus trap — composer focuses itself on render).
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // Reset to the default width whenever the drawer closes (re-opens narrow).
  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);

  if (!open) return null;

  return (
    <div
      data-testid="copilot-drawer-root"
      className="fixed inset-0 z-[60]"
      aria-hidden={open ? 'false' : 'true'}
    >
      <button
        type="button"
        aria-label="关闭 Copilot 抽屉"
        onClick={onClose}
        data-testid="copilot-drawer-scrim"
        className="absolute inset-0 bg-[rgba(15,18,22,0.32)]"
      />
      <aside
        ref={panelRef}
        // biome-ignore lint/a11y/useSemanticElements: native <dialog> requires
        // imperative showModal()/close() API which doesn't compose with the
        // controlled `open` prop + scrim/focus story used here.
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title ?? 'Copilot 抽屉'}
        tabIndex={-1}
        data-testid="copilot-drawer-panel"
        className={[
          'absolute right-0 top-0 h-full w-full',
          expanded ? 'sm:w-[min(900px,92vw)]' : 'sm:w-[420px]',
          'bg-[var(--paper-raised)] border-l border-[var(--line)]',
          'shadow-[var(--shadow-3)] flex flex-col outline-none',
          'animate-in slide-in-from-right duration-[var(--dur-fast)]',
        ].join(' ')}
      >
        {/* drawer-head（copilot.jsx L105-112 / loom.css L285-286）：
            coral card-icon + 19px serif 标题 + 状态徽标 + 右簇动作按钮。 */}
        <header className="drawer-head">
          <span className="card-icon accent">
            <LoomIcon name={icon} size={18} />
          </span>
          <div className="drawer-title serif">{title}</div>
          {headBadge}
          <div className="ml-auto flex items-center gap-[6px]">
            {expandable ? (
              <IconBtn
                icon={expanded ? 'minimize' : 'maximize'}
                size={16}
                title={expanded ? '还原宽度' : '全屏 Copilot'}
                aria-label={expanded ? '还原宽度' : '全屏 Copilot'}
                onClick={() => setExpanded((v) => !v)}
                data-testid="copilot-drawer-expand"
              />
            ) : null}
            {headActions}
            <IconBtn
              icon="close"
              size={16}
              onClick={onClose}
              aria-label="关闭"
              data-testid="copilot-drawer-close"
            />
          </div>
        </header>
        {summary ? (
          <section
            data-testid="copilot-drawer-summary"
            className="px-[18px] py-[12px] border-b border-[var(--line-soft)] text-[13px] text-[var(--ink-2)] leading-[1.55]"
          >
            {summary}
          </section>
        ) : null}
        <section
          data-testid="copilot-drawer-chat"
          className="flex-1 overflow-y-auto px-[18px] py-[12px] flex flex-col gap-[8px]"
        >
          {children}
        </section>
        {footer ? (
          <footer
            data-testid="copilot-drawer-footer"
            className="px-[18px] py-[12px] border-t border-[var(--line-soft)]"
          >
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

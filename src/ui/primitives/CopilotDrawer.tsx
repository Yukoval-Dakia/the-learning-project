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

import { type ReactNode, useEffect, useRef } from 'react';
import { Button } from './Button';

export interface CopilotDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
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
  summary,
  children,
  footer,
  ariaLabel,
}: CopilotDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

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
          'absolute right-0 top-0 h-full w-full sm:w-[420px]',
          'bg-[var(--paper-raised)] border-l border-[var(--line)]',
          'shadow-[var(--shadow-3)] flex flex-col outline-none',
          'animate-in slide-in-from-right duration-[var(--dur-fast)]',
        ].join(' ')}
      >
        <header className="flex items-center justify-between px-[18px] py-[14px] border-b border-[var(--line-soft)]">
          <h2 className="text-[14px] font-[600] text-[var(--ink)]">{title}</h2>
          <Button
            variant="quiet"
            size="sm"
            onClick={onClose}
            aria-label="关闭"
            data-testid="copilot-drawer-close"
          >
            收起
          </Button>
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

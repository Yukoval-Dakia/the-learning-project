// Wave 5 / T-D3/A — generic Copilot Drawer primitive.
//
// Slot-based slide-out panel for the global Copilot Dock (mounted app-wide in
// (app)/layout.tsx — AF S2a; previously page-scoped, now global). Two slots:
//   • summary  — Coach TodayPlan.daily_focus + review_due + dreaming preview
//   • chat     — message list + tool-use cards + composer
//
// RTL slide-in (from the right). ESC + outside-click close. Open state is
// controlled by the parent (explicit user/signal open only). The primitive intentionally
// does no data fetching — keeps T-D3/A reusable.

'use client';

import { type ReactNode, useState } from 'react';
import { IconBtn } from './IconBtn';
import { LoomIcon, type LoomIconName } from './LoomIcon';
import { useFocusTrap } from './useFocusTrap';

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

// Lock body scroll while the drawer is mounted (mobile UX). A ref callback on the
// root that only exists while open: attach saves the previous inline overflow and
// sets hidden, detach restores it.
function lockBodyScroll(node: HTMLDivElement | null): (() => void) | undefined {
  if (!node) return undefined;
  const prev = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => {
    document.body.style.overflow = prev;
  };
}

export function CopilotDrawer(props: CopilotDrawerProps) {
  // YUK-718 — focus trap + restore + Esc close via the shared primitive, same as
  // NodeDrawer / CommandPalette / PfSolo: focuses the first focusable element on
  // open, traps Tab within the panel, closes on Esc (only the topmost trap acts), and
  // restores focus to the trigger on close.
  const trapRef = useFocusTrap(props.open, props.onClose);

  if (!props.open) return null;
  // The open panel is its own subtree, so every close (scrim, Esc, or the parent
  // setting open=false) drops the width toggle and the next open starts narrow.
  return <OpenCopilotDrawer {...props} trapRef={trapRef} />;
}

function OpenCopilotDrawer({
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
  trapRef,
}: CopilotDrawerProps & { trapRef: (panel: HTMLElement | null) => (() => void) | undefined }) {
  // 全屏 Copilot（copilot.jsx L109 maximize）= 宽度切换的纯 chrome 状态：
  // 默认 420px 侧栏 ↔ 展开 min(900px, 92vw) 的宽读模式。
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      ref={lockBodyScroll}
      data-testid="copilot-drawer-root"
      className="fixed inset-0 z-[60]"
      aria-hidden="false"
    >
      <button
        type="button"
        aria-label="关闭 Copilot 抽屉"
        onClick={onClose}
        data-testid="copilot-drawer-scrim"
        className="absolute inset-0 bg-[rgba(15,18,22,0.32)]"
      />
      <aside
        ref={trapRef}
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
          expanded ? 'sm:w-full' : 'sm:w-[420px]',
          'bg-[var(--paper-raised)] border-l border-[var(--line)]',
          'shadow-[var(--shadow-3)] flex flex-col outline-none transition-[width]',
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
              <span className="hidden sm:inline-flex">
                <IconBtn
                  icon={expanded ? 'minimize' : 'maximize'}
                  size={16}
                  title={expanded ? '还原宽度' : '全屏 Copilot'}
                  aria-label={expanded ? '还原宽度' : '全屏 Copilot'}
                  aria-pressed={expanded}
                  onClick={() => setExpanded((v) => !v)}
                  data-testid="copilot-drawer-expand"
                />
              </span>
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
            className="max-h-[45vh] shrink-0 overflow-y-auto px-[18px] py-[12px] border-b border-[var(--line-soft)] text-[13px] text-[var(--ink-2)] leading-[1.55]"
          >
            {summary}
          </section>
        ) : null}
        <section
          data-testid="copilot-drawer-chat"
          className="min-h-0 flex-1 overflow-y-auto px-[18px] py-[12px] flex flex-col gap-[8px]"
        >
          {children}
        </section>
        {footer ? (
          <footer
            data-testid="copilot-drawer-footer"
            className="shrink-0 px-[18px] py-[12px] border-t border-[var(--line-soft)]"
          >
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

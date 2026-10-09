import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  /** Shortcut hint shown in the row (N4). */
  hint?: ReactNode;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: readonly PaletteCommand[];
  placeholder?: string;
  emptyText?: string;
}

/**
 * Command palette (N4): a glass modal with a combobox over a listbox. Arrow keys move, Enter runs,
 * Esc closes and returns focus to where it was. It shares the app's focus-trap stack, so a single
 * Esc closes exactly one layer. It does not bind ⌘K itself; the app shell owns that shortcut.
 * Closed, it is inert (A1).
 */
export function CommandPalette({
  open,
  onClose,
  commands,
  placeholder = '搜索、跳转，或输入要做的事',
  emptyText = '没有匹配的命令',
}: CommandPaletteProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  useFocusTrap(open, onClose, panelRef);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim();
    return q ? commands.filter((c) => c.label.includes(q) || c.group.includes(q)) : commands;
  }, [commands, query]);

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(visible.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(visible[active]);
    }
  };

  let lastGroup = '';
  return (
    <div className="un-palette-layer" data-open={open} inert={!open}>
      <button
        type="button"
        className="un-palette-scrim"
        aria-label="关闭命令面板"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="un-palette un-glass"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <input
          className="un-palette-input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={visible.length ? optionId(active) : undefined}
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div id={listId} role="listbox" aria-label="命令" className="un-palette-list">
          {visible.length === 0 && <p className="un-palette-empty">{emptyText}</p>}
          {visible.map((c, i) => {
            const heading = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id} role="presentation">
                {heading && (
                  <p className="un-palette-group" aria-hidden="true">
                    {heading}
                  </p>
                )}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: options never take focus; the combobox input drives them with aria-activedescendant and handles Enter. */}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  className="un-palette-option"
                  onPointerEnter={() => setActive(i)}
                  onClick={() => run(c)}
                >
                  {c.icon && (
                    <span className="un-palette-icon" aria-hidden="true">
                      {c.icon}
                    </span>
                  )}
                  <span className="un-palette-label">{c.label}</span>
                  {c.hint && <span className="un-palette-hint">{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// @vitest-environment jsdom

// YUK-718 round-1 (codex #3610033039) — stacked traps. With the Copilot drawer open,
// opening CommandPalette then pressing Esc must close ONLY the palette (the topmost
// trap), not the drawer beneath it. useFocusTrap keeps a module-level stack so only
// the most-recently-opened trap responds to Esc; when it closes, the next becomes
// topmost. These tests drive the hook directly with two stacked panels.

import { cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

afterEach(cleanup);

function TrapPanel({
  open,
  onClose,
  label,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, onClose, ref);
  if (!open) return null;
  // A plain panel with a focusable child is all the trap needs (role="dialog" is
  // the real components' concern, not the hook's) — keeps this harness lint-clean.
  return (
    <div ref={ref} aria-label={label}>
      <button type="button">{label}</button>
    </div>
  );
}

function Stack(props: {
  bottomOpen: boolean;
  topOpen: boolean;
  onCloseBottom: () => void;
  onCloseTop: () => void;
}) {
  return (
    <>
      <TrapPanel open={props.bottomOpen} onClose={props.onCloseBottom} label="drawer" />
      <TrapPanel open={props.topOpen} onClose={props.onCloseTop} label="palette" />
    </>
  );
}

describe('useFocusTrap stacked Esc (YUK-718)', () => {
  it('Esc closes only the topmost trap, then the next one', () => {
    const onCloseBottom = vi.fn();
    const onCloseTop = vi.fn();
    const { rerender } = render(
      <Stack bottomOpen topOpen onCloseBottom={onCloseBottom} onCloseTop={onCloseTop} />,
    );

    // Both open → Esc reaches only the topmost (palette).
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseTop).toHaveBeenCalledTimes(1);
    expect(onCloseBottom).not.toHaveBeenCalled();

    // Palette actually closes → its token pops, drawer becomes topmost.
    rerender(
      <Stack bottomOpen topOpen={false} onCloseBottom={onCloseBottom} onCloseTop={onCloseTop} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseBottom).toHaveBeenCalledTimes(1);
    expect(onCloseTop).toHaveBeenCalledTimes(1); // unchanged
  });

  it('a single trap still closes on Esc', () => {
    const onClose = vi.fn();
    render(<TrapPanel open onClose={onClose} label="solo" />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps stack order when the bottom trap re-renders with a new onClose identity', () => {
    // Regression for the latest-ref design: an unstable onClose must NOT re-run the
    // effect and re-push the bottom trap above the palette.
    const onCloseTop = vi.fn();
    const { rerender } = render(
      <Stack bottomOpen topOpen onCloseBottom={() => undefined} onCloseTop={onCloseTop} />,
    );
    rerender(<Stack bottomOpen topOpen onCloseBottom={() => undefined} onCloseTop={onCloseTop} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseTop).toHaveBeenCalledTimes(1);
  });
});

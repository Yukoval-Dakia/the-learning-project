// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppTopbar } from './AppTopbar';

afterEach(cleanup);

const baseProps = {
  pathname: '/today',
  onOpenMobileNav: vi.fn(),
  onToggleRail: vi.fn(),
  railCollapsed: false,
  onOpenPalette: vi.fn(),
  onOpenCopilot: vi.fn(),
};

describe('AppTopbar Copilot launcher', () => {
  it('announces pending nudges through the actionable launcher', () => {
    render(<AppTopbar {...baseProps} copilotNudgeCount={2} />);

    expect(screen.getByRole('button', { name: 'Copilot，2 条主动提示' })).toBeTruthy();
    const badge = screen.getByTestId('copilot-nudge-launcher-badge');
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
  });

  it('hides the entire internal launcher wrapper without hiding the fixed drawer', () => {
    const dockSource = readFileSync(
      join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
      'utf8',
    );
    const cssSource = readFileSync(join(process.cwd(), 'web/src/globals.css'), 'utf8');
    const routerSource = readFileSync(join(process.cwd(), 'web/src/router.tsx'), 'utf8');

    expect(dockSource).toContain('className="copilot-launcher relative inline-flex"');
    expect(dockSource).toContain('onNudgeCountChange?.(nudges.length)');
    expect(routerSource).toContain('onNudgeCountChange={setCopilotNudgeCount}');
    expect(cssSource).toContain('.shell-copilot-mount > .copilot-launcher');
    expect(cssSource).not.toContain(
      '.shell-copilot-mount > [data-testid="copilot-drawer-trigger"]',
    );
  });
});

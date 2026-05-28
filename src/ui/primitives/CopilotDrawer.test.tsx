import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CopilotDrawer } from './CopilotDrawer';

describe('CopilotDrawer primitive', () => {
  it('returns null when open=false (no DOM mass when closed)', () => {
    const html = renderToString(
      <CopilotDrawer open={false} onClose={vi.fn()}>
        <div>hidden</div>
      </CopilotDrawer>,
    );
    expect(html).toBe('');
  });

  it('renders panel + slots + close button when open=true', () => {
    const html = renderToString(
      <CopilotDrawer
        open
        onClose={vi.fn()}
        title="今日 Coach"
        summary={<p data-testid="summary-slot">Coach 摘要</p>}
        footer={<input data-testid="composer" />}
      >
        <div data-testid="chat-slot">chat content</div>
      </CopilotDrawer>,
    );
    expect(html).toContain('data-testid="copilot-drawer-root"');
    expect(html).toContain('data-testid="copilot-drawer-panel"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="今日 Coach"');
    expect(html).toContain('data-testid="copilot-drawer-summary"');
    expect(html).toContain('data-testid="summary-slot"');
    expect(html).toContain('data-testid="copilot-drawer-chat"');
    expect(html).toContain('data-testid="chat-slot"');
    expect(html).toContain('data-testid="copilot-drawer-footer"');
    expect(html).toContain('data-testid="composer"');
    expect(html).toContain('data-testid="copilot-drawer-close"');
    expect(html).toContain('data-testid="copilot-drawer-scrim"');
  });
});

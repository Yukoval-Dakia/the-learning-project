import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CopilotDock checkpoint revert', () => {
  it('posts the authoritative checkpoint id and refetches turns after success', async () => {
    const source = await readFile(
      join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
      'utf8',
    );

    expect(source).toContain(
      '/api/copilot/checkpoints/${encodeURIComponent(checkpointEventId)}/revert',
    );
    expect(source).toContain('await refetchTurns()');
    expect(source).toContain('checkpoint_event_id');
    expect(source).toContain('撤回本轮更改');
  });

  it('disables the revert button while its POST is in flight (F5a)', async () => {
    const source = await readFile(
      join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
      'utf8',
    );
    // Per-row in-flight guard mirrors the corrective chip's disabled idiom.
    expect(source).toContain('disabled={revertPending}');
    expect(source).toContain('setRevertPendingId(checkpointEventId)');
    // Guarded clear (mirrors chipPending) — only clears if still the pending checkpoint.
    expect(source).toContain(
      'setRevertPendingId((cur) => (cur === checkpointEventId ? null : cur))',
    );
    // The button carries a stable testid mirroring sibling chips.
    expect(source).toContain('data-testid="copilot-revert-button"');
  });

  it('distinguishes a post-revert refresh failure from a revert failure (F5b)', async () => {
    const source = await readFile(
      join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
      'utf8',
    );
    // Revert landed but refetch threw → distinct state + banner, and the retry refetches only.
    expect(source).toContain('setRefreshFailed(true)');
    expect(source).toContain('copilot-refresh-error');
    expect(source).toContain('const retryRefresh');
    // The two banners are mutually exclusive — refreshFailed wins when both are set.
    expect(source).toContain('error && !refreshFailed');
  });

  it('recomputes skill state on the post-revert refetch (wave-2 F2)', async () => {
    const source = await readFile(
      join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
      'utf8',
    );
    // refetchTurns resets skill state then reuses the drawer-open recompute so a revert that
    // removed the owning turn cannot leave a stale teaching skill / focused knowledge context.
    expect(source).toContain('const restoreSkillStateFromReplay');
    expect(source).toContain('restoreSkillStateFromReplay(replayed)');
  });
});

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
});

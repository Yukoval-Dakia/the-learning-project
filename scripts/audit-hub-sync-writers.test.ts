import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { type AllowlistEntry, auditHubSyncWriters } from './audit-hub-sync-writers';

const emptyAllowlist: AllowlistEntry[] = [];
const fixtures: string[] = [];

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hub-sync-audit-'));
  fixtures.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('auditHubSyncWriters', () => {
  it.each([
    [
      'topology writer',
      "await db.update(knowledge).set({ name: 'x' });",
      'UNINVENTORIED_TOPOLOGY_WRITER',
    ],
    [
      'cursor writer',
      "await db.update(hub_sync_reconciliation).set({ status: 'acknowledged' });",
      'RECONCILIATION_OWNER_BYPASS',
    ],
    [
      'internal marker',
      "await db.execute(sql`set local app.hub_sync_internal_apply = '1'`);",
      'INTERNAL_APPLY_MARKER_BYPASS',
    ],
    [
      'direct apply actor',
      "persistNoteRefineApply({ db, artifactId, patch, actorRef: 'hub_auto_sync' });",
      'DIRECT_HUB_ACTOR_APPLY',
    ],
  ] as const)('YUK-384 RED 25: catches %s bypass', async (_name, source, rule) => {
    const root = fixtureRepo({ 'src/bypass.ts': source });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(expect.objectContaining({ rule, file: 'src/bypass.ts' }));
  });

  it('YUK-384 RED 25: an allowlisted topology writer is NOT flagged', async () => {
    const root = fixtureRepo({ 'src/writer.ts': 'await db.insert(knowledge_edge).values({});' });
    const findings = await auditHubSyncWriters({
      root,
      allowlist: [{ path: 'src/writer.ts', tables: ['knowledge_edge'], reason: 'test' }],
    });
    expect(findings).toEqual([]);
  });
});
